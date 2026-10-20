import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ModSession } from "../../scripts/mod-session";
import { localSessionDriver } from "./cli-session-driver";
import { runSql, schema } from "./policy-fixture";

const migration = readFileSync(
  new URL("../../app/db/migrations/0005_cli_sessions.sql", import.meta.url),
  "utf8",
);
const config = {
  databaseUrl: "postgresql://synthetic:synthetic@cli-fixture.invalid/test",
  origin: "https://vrooms.test",
};
let restore: (() => void) | undefined;
let clock = 0;

async function session() {
  const driver = localSessionDriver();
  restore = driver.restore;
  const session = new ModSession(config, { sql: driver.sql, now: () => clock });
  await session.start();
  return session;
}

function hash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

beforeAll(async () => {
  await runSql(`CREATE SCHEMA "${schema}";`, { scope: false });
});
beforeEach(async () => {
  clock = 0;
  await runSql(
    "DROP TABLE IF EXISTS cli_sessions CASCADE; DROP FUNCTION IF EXISTS guard_cli_session();",
  );
  await runSql(migration);
});
afterEach(() => {
  restore?.();
});
afterAll(async () => {
  await runSql(`DROP SCHEMA "${schema}" CASCADE;`, { scope: false });
});

describe("CLI session SQL against real PostgreSQL", () => {
  it("registers, rotates atomically, keeps old expiry fixed, and revokes on exit", async () => {
    const current = await session();
    const token = await current.token();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const oldExpiry = await runSql(
      `SELECT expires_at FROM cli_sessions WHERE token_hash = '${hash(token)}';`,
    );
    await current.renew();
    const next = await current.token();
    expect(next).not.toBe(token);
    expect(
      await runSql(
        `SELECT expires_at FROM cli_sessions WHERE token_hash = '${hash(token)}';`,
      ),
    ).toBe(oldExpiry);
    expect(
      await runSql(
        `SELECT revoked_at IS NOT NULL FROM cli_sessions WHERE token_hash = '${hash(token)}';`,
      ),
    ).toBe("t");
    expect(
      await runSql(
        `SELECT revoked_at IS NULL FROM cli_sessions WHERE token_hash = '${hash(next)}';`,
      ),
    ).toBe("t");
    expect(
      await runSql(
        `SELECT count(*) FROM cli_sessions WHERE token_hash IN ('${token}', '${next}');`,
      ),
    ).toBe("0");
    await current.revoke();
    expect(
      await runSql(
        "SELECT count(*) FROM cli_sessions WHERE revoked_at IS NULL;",
      ),
    ).toBe("0");
  });

  it("renews an expired unrevoked row through fresh database authority", async () => {
    const current = await session();
    const token = await current.token();
    await runSql(
      "ALTER TABLE cli_sessions DISABLE TRIGGER cli_sessions_guard; UPDATE cli_sessions SET created_at = statement_timestamp() - interval '16 minutes', expires_at = statement_timestamp() - interval '1 minute'; ALTER TABLE cli_sessions ENABLE TRIGGER cli_sessions_guard;",
    );
    clock = 901_000;
    expect(await current.token()).not.toBe(token);
    expect(
      await runSql(
        "SELECT count(*) FROM cli_sessions WHERE revoked_at IS NULL AND expires_at > statement_timestamp();",
      ),
    ).toBe("1");
    await current.revoke();
  });

  it.each([
    "UPDATE cli_sessions SET revoked_at = statement_timestamp();",
    "DELETE FROM cli_sessions;",
  ])("refuses to renew a revoked or removed predecessor", async (mutation) => {
    const current = await session();
    await runSql(mutation);
    await expect(current.renew()).rejects.toMatchObject({ fatal: true });
    expect(
      await runSql(
        "SELECT count(*) FROM cli_sessions WHERE revoked_at IS NULL;",
      ),
    ).toBe("0");
    await current.revoke();
  });

  it("rolls back registration and predecessor revocation if the transaction fails", async () => {
    const current = await session();
    const token = await current.token();
    await runSql(`CREATE FUNCTION fail_rotation() RETURNS trigger LANGUAGE plpgsql AS $failure$
      BEGIN RAISE EXCEPTION 'synthetic failure'; END; $failure$;
      CREATE TRIGGER fail_rotation BEFORE UPDATE ON cli_sessions FOR EACH ROW EXECUTE FUNCTION fail_rotation();`);
    await expect(current.renew()).rejects.toMatchObject({ fatal: true });
    expect(await current.token()).toBe(token);
    expect(await runSql("SELECT count(*) FROM cli_sessions;")).toBe("1");
    expect(await runSql("SELECT revoked_at IS NULL FROM cli_sessions;")).toBe(
      "t",
    );
    await runSql(
      "DROP TRIGGER fail_rotation ON cli_sessions; DROP FUNCTION fail_rotation();",
    );
    await current.revoke();
  });

  it("cleans at most 100 old terminal rows without removing live or newly revoked rows", async () => {
    await runSql(`INSERT INTO cli_sessions(token_hash, origin) SELECT lpad(to_hex(n), 64, '0'), '${config.origin}' FROM generate_series(1, 107) n;
      ALTER TABLE cli_sessions DISABLE TRIGGER cli_sessions_guard;
      UPDATE cli_sessions SET created_at = statement_timestamp() - interval '8 days 15 minutes', expires_at = statement_timestamp() - interval '8 days' WHERE token_hash <= lpad(to_hex(105), 64, '0');
      UPDATE cli_sessions SET revoked_at = statement_timestamp() WHERE token_hash = lpad(to_hex(106), 64, '0');
      ALTER TABLE cli_sessions ENABLE TRIGGER cli_sessions_guard;`);
    const current = await session();
    expect(await runSql("SELECT count(*) FROM cli_sessions;")).toBe("8");
    expect(
      await runSql(
        "SELECT count(*) FROM cli_sessions WHERE expires_at <= statement_timestamp() - interval '7 days';",
      ),
    ).toBe("5");
    expect(
      await runSql(
        "SELECT count(*) FROM cli_sessions WHERE expires_at > statement_timestamp() AND revoked_at IS NULL;",
      ),
    ).toBe("2");
    expect(
      await runSql(
        "SELECT count(*) FROM cli_sessions WHERE revoked_at > statement_timestamp() - interval '1 minute';",
      ),
    ).toBe("1");
    await current.revoke();
  });
});
