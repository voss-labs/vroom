import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { Query } from "drizzle-orm";
import * as tables from "~/db/schema";
import { prepared, runSql, schema } from "./policy-fixture";

const queries: Query[] = [];
vi.mock("~/db", async () => ({
  db: drizzle(
    async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
    { schema: tables },
  ),
}));
const { findLiveCliSession } = await import("~/db/queries/cli-sessions");
const migration = readFileSync(
  new URL("../../app/db/migrations/0005_cli_sessions.sql", import.meta.url),
  "utf8",
);
const id = "10000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);
const origin = "https://vrooms.test";
const reader = `${schema}_reader`;
const publicOnly = `${schema}_public`;
let created = false;

async function insert(extra = "", values = "") {
  return runSql(
    `INSERT INTO cli_sessions(id, token_hash, origin${extra}) VALUES ('${id}', '${hash}', '${origin}'${values}) RETURNING id;`,
  );
}

async function live(
  tokenHash = hash,
  requestOrigin = origin,
  sessionId?: string,
) {
  await findLiveCliSession(tokenHash, requestOrigin, sessionId);
  return runSql(prepared(queries[queries.length - 1]));
}

beforeAll(async () => {
  await runSql(
    `CREATE SCHEMA "${schema}";
    CREATE ROLE "${reader}" NOLOGIN;
    CREATE ROLE "${publicOnly}" NOLOGIN;
    GRANT USAGE ON SCHEMA "${schema}" TO "${reader}", "${publicOnly}";`,
    { scope: false },
  );
  created = true;
});
beforeEach(async () => {
  queries.length = 0;
  await runSql(
    "DROP TABLE IF EXISTS cli_sessions CASCADE; DROP FUNCTION IF EXISTS guard_cli_session();",
  );
  await runSql(migration);
});
afterAll(async () => {
  if (created)
    await runSql(
      `DROP SCHEMA "${schema}" CASCADE; DROP ROLE "${reader}"; DROP ROLE "${publicOnly}";`,
      { scope: false },
    );
});

describe("CLI credential migration and actual query", () => {
  it("registers without member/auth tables and stamps immutable DB lifetime", async () => {
    await insert(
      ", created_at, expires_at, revoked_at",
      ", '1900-01-01', '2100-01-01', '1900-01-01'",
    );
    const row = JSON.parse(
      await runSql(
        "SELECT json_build_object('fresh', abs(extract(epoch from created_at - statement_timestamp())) < 5, 'seconds', extract(epoch from expires_at - created_at), 'revoked', revoked_at) FROM cli_sessions;",
      ),
    );
    expect(row).toEqual({ fresh: true, seconds: 900, revoked: null });
    expect(await live(hash, origin, id)).toBe(id);
    expect(
      await runSql(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('members', 'user');",
      ),
    ).toBe("0");
  });

  it.each([
    "token_hash = repeat('b', 64)",
    "origin = 'https://other.test'",
    "id = gen_random_uuid()",
    "created_at = created_at - interval '1 second'",
    "expires_at = expires_at + interval '1 second'",
    "expires_at = expires_at - interval '1 second'",
  ])("rejects immutable update %s", async (assignment) => {
    await insert();
    await expect(
      runSql(`UPDATE cli_sessions SET ${assignment};`),
    ).rejects.toThrow("immutable");
    expect(await live(hash, origin, id)).toBe(id);
  });

  it("stamps one-way revocation and denies revoked credentials", async () => {
    await insert();
    await runSql("UPDATE cli_sessions SET revoked_at = '2100-01-01';");
    expect(
      await runSql(
        "SELECT abs(extract(epoch from revoked_at - statement_timestamp())) < 5 FROM cli_sessions;",
      ),
    ).toBe("t");
    expect(await live()).toBe("");
    for (const assignment of [
      "revoked_at = NULL",
      "revoked_at = revoked_at + interval '1 second'",
    ]) {
      await expect(
        runSql(`UPDATE cli_sessions SET ${assignment};`),
      ).rejects.toThrow("immutable");
    }
    await runSql("UPDATE cli_sessions SET revoked_at = revoked_at;");
    expect(await live()).toBe("");
  });

  it.each(["'bad'", "repeat('A', 64)", "repeat('a', 63)"])(
    "rejects malformed hash %s",
    async (value) => {
      await expect(
        runSql(
          `INSERT INTO cli_sessions(token_hash, origin) VALUES (${value}, '${origin}');`,
        ),
      ).rejects.toThrow("cli_sessions_token_hash");
    },
  );

  it("rejects duplicate hash and blank origin", async () => {
    await insert();
    await expect(
      runSql(
        `INSERT INTO cli_sessions(token_hash, origin) VALUES ('${hash}', '${origin}');`,
      ),
    ).rejects.toThrow("unique constraint");
    await expect(
      runSql(
        `INSERT INTO cli_sessions(token_hash, origin) VALUES (repeat('b', 64), E' \\t\\n');`,
      ),
    ).rejects.toThrow("cli_sessions_origin");
  });

  it("binds the live SELECT to hash, origin and id with no normalization or writes", async () => {
    await insert();
    expect(await live("b".repeat(64))).toBe("");
    expect(await live(hash, "https://vrooms.test:444")).toBe("");
    expect(
      await live(hash, origin, "20000000-0000-4000-8000-000000000001"),
    ).toBe("");
    expect(await live()).toBe(id);
    const query = queries[queries.length - 1];
    expect(query.sql).toContain("statement_timestamp()");
    expect(query.sql.toLowerCase()).not.toMatch(
      /insert|update|delete|members|user/,
    );
    await runSql("DELETE FROM cli_sessions;");
    expect(await live()).toBe("");
  });

  it("denies exact expiry using DB time independently of workstation clock", async () => {
    await insert();
    await findLiveCliSession(hash, origin);
    const query = prepared(queries[queries.length - 1]);
    const result =
      await runSql(`BEGIN; ALTER TABLE cli_sessions DISABLE TRIGGER cli_sessions_guard;
      UPDATE cli_sessions SET created_at = statement_timestamp() - interval '15 minutes', expires_at = statement_timestamp();
      ${query}
      ROLLBACK;`);
    expect(result).toBe("");
  });

  it("denies read-only registration and limits runtime to SELECT despite PUBLIC defaults", async () => {
    await insert();
    await runSql(`GRANT SELECT ON cli_sessions TO "${reader}";`);
    expect(
      await runSql(`SET ROLE "${reader}"; SELECT id FROM cli_sessions;`),
    ).toBe(id);
    for (const sql of [
      `INSERT INTO cli_sessions(token_hash, origin) VALUES (repeat('b',64), '${origin}');`,
      "UPDATE cli_sessions SET revoked_at = now();",
      "DELETE FROM cli_sessions;",
      "ALTER TABLE cli_sessions DISABLE TRIGGER cli_sessions_guard;",
    ])
      await expect(runSql(`SET ROLE "${reader}"; ${sql}`)).rejects.toThrow(
        /permission denied|must be owner/,
      );
    for (const sql of [
      "SELECT * FROM cli_sessions;",
      `INSERT INTO cli_sessions(token_hash, origin) VALUES (repeat('c',64), '${origin}');`,
    ]) {
      await expect(runSql(`SET ROLE "${publicOnly}"; ${sql}`)).rejects.toThrow(
        "permission denied",
      );
    }
    expect(
      await runSql(`SELECT pg_has_role('${reader}', current_user, 'MEMBER');`),
    ).toBe("f");
    expect(
      await runSql(
        `SELECT has_table_privilege('${reader}', 'cli_sessions', 'TRIGGER');`,
      ),
    ).toBe("f");
  });

  it("supports schema-first empty setup and safe reruns with required guards", async () => {
    await runSql(`DROP TABLE cli_sessions;
      CREATE TABLE cli_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), token_hash text UNIQUE NOT NULL,
        origin text NOT NULL, created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
        expires_at timestamptz NOT NULL DEFAULT statement_timestamp() + interval '15 minutes', revoked_at timestamptz);`);
    await runSql(migration);
    await insert();
    const created = await runSql("SELECT created_at FROM cli_sessions;");
    await runSql(migration);
    expect(await runSql("SELECT created_at FROM cli_sessions;")).toBe(created);
    await expect(
      runSql(
        `INSERT INTO cli_sessions(token_hash, origin) VALUES ('invalid', '${origin}');`,
      ),
    ).rejects.toThrow("cli_sessions_token_hash");
    await expect(
      runSql(
        "UPDATE cli_sessions SET expires_at = expires_at + interval '1 second';",
      ),
    ).rejects.toThrow("immutable");
  });

  it("removes named-role and PUBLIC grants inherited from default privileges", async () => {
    await runSql(
      `DROP TABLE cli_sessions CASCADE; DROP FUNCTION guard_cli_session(); ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON TABLES TO PUBLIC; ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" GRANT ALL ON TABLES TO "${reader}";`,
    );
    try {
      await runSql(migration);
      expect(
        await runSql(
          `SELECT has_table_privilege('${publicOnly}', 'cli_sessions', 'INSERT');`,
        ),
      ).toBe("f");
      expect(
        await runSql(
          `SELECT has_table_privilege('${publicOnly}', 'cli_sessions', 'SELECT');`,
        ),
      ).toBe("f");
      expect(
        await runSql(
          `SELECT has_table_privilege('${reader}', 'cli_sessions', 'INSERT');`,
        ),
      ).toBe("f");
      expect(
        await runSql(
          `SELECT has_table_privilege('${reader}', 'cli_sessions', 'SELECT');`,
        ),
      ).toBe("f");
    } finally {
      await runSql(
        `ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" REVOKE ALL ON TABLES FROM PUBLIC; ALTER DEFAULT PRIVILEGES IN SCHEMA "${schema}" REVOKE ALL ON TABLES FROM "${reader}";`,
      );
    }
  });
});
