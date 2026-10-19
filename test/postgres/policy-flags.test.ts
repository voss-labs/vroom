import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  fixtureSql,
  memberId,
  prepared,
  runSql,
  schema,
  state,
} from "./policy-fixture";

const execute = vi.hoisted(() => vi.fn());
vi.mock("~/db", () => ({ db: { execute } }));

const { materializePolicyFlag } = await import("~/db/queries/policy-flags");
const input = {
  roomId: "campus-live",
  flagId: 7,
  reportedMemberId: memberId,
  pseudonym: "quiet-ibex",
  snippet: "retained snippet",
  reason: "Blocked automatically.",
  autoSuspended: true,
};
let created = false;

async function query(overrides: Partial<typeof input> = {}) {
  await materializePolicyFlag({ ...input, ...overrides });
  return new PgDialect().sqlToQuery(execute.mock.lastCall![0] as SQL);
}

beforeAll(async () => {
  await runSql(`CREATE SCHEMA "${schema}";`, { scope: false });
  created = true;
  await runSql(fixtureSql);
});

beforeEach(async () => {
  vi.resetAllMocks();
  execute.mockResolvedValue({ rows: [] });
  await runSql(`TRUNCATE moderation_audit, reports, members, member_updates;
    INSERT INTO members(id) VALUES ('${memberId}'); INSERT INTO member_updates VALUES (0);`);
});

afterAll(async () => {
  if (created)
    await runSql(`DROP SCHEMA "${schema}" CASCADE;`, { scope: false });
});

describe("policy materialization against PostgreSQL", () => {
  it.each(["members", "moderation_audit"])(
    "rolls back every Neon effect when %s fails and retries once",
    async (table) => {
      const statement = prepared(await query());
      await expect(
        runSql(`SET vroom.test_fault = '${table}'; ${statement}`),
      ).rejects.toThrow(`injected failure on ${table}`);
      expect(await state()).toEqual({
        reports: 0,
        audits: 0,
        suspended: false,
        updates: 0,
      });
      await runSql(statement);
      expect(await state()).toEqual({
        reports: 1,
        audits: 1,
        suspended: true,
        updates: 1,
      });
      const audit = JSON.parse(
        await runSql(
          "SELECT json_build_object('action', action, 'actorKind', actor_kind, 'details', details) FROM moderation_audit;",
        ),
      );
      expect(audit).toEqual({
        action: "auto_suspend",
        actorKind: "console",
        details: { handle: "quiet-ibex", flagId: 7 },
      });
    },
  );

  it("preserves restoration and exactly-once effects when a completed flag is replayed", async () => {
    const statement = prepared(await query());
    await runSql(statement);
    await runSql(
      "UPDATE members SET suspended_at = NULL, suspended_reason = NULL;",
    );
    expect(await state()).toEqual({
      reports: 1,
      audits: 1,
      suspended: false,
      updates: 2,
    });
    await runSql(statement);
    expect(await state()).toEqual({
      reports: 1,
      audits: 1,
      suspended: false,
      updates: 2,
    });
  });

  it("creates an ordinary blocked report without updating suspension or audit", async () => {
    await runSql(prepared(await query({ autoSuspended: false })));
    expect(await state()).toEqual({
      reports: 1,
      audits: 0,
      suspended: false,
      updates: 0,
    });
  });

  it("makes overlapping readers wait for atomic completion and commit only once", async () => {
    const statement = prepared(await query());
    let waiting!: () => void;
    const ready = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const first = runSql(`SET vroom.test_fault = 'pause'; ${statement}`, {
      onStderr: (chunk) => {
        if (chunk.includes("policy-materialization-waiting")) waiting();
      },
    });
    await Promise.race([
      ready,
      first.then(() => {
        throw new Error(
          "The first reader did not pause inside materialization.",
        );
      }),
    ]);
    const second = runSql(statement);
    await Promise.all([first, second]);
    expect(await state()).toEqual({
      reports: 1,
      audits: 1,
      suspended: true,
      updates: 1,
    });
  });
});
