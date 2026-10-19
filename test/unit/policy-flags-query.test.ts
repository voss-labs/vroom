import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const execute = vi.hoisted(() => vi.fn());
vi.mock("~/db", () => ({ db: { execute } }));

const { materializePolicyFlag } = await import("~/db/queries/policy-flags");
const input = {
  roomId: "campus-live",
  flagId: 7,
  reportedMemberId: "00000000-0000-0000-0000-000000000001",
  pseudonym: "quiet-ibex",
  snippet: "blocked message",
  reason: "blocked abuse",
  autoSuspended: true,
};

function query() {
  const statement = execute.mock.calls[0][0] as SQL;
  return new PgDialect().sqlToQuery(statement);
}

beforeEach(() => {
  vi.resetAllMocks();
  execute.mockResolvedValue({ rows: [{ id: "report-7" }] });
});

describe("atomic policy flag query", () => {
  it("executes one parameterized statement for report, suspension and audit", async () => {
    expect(await materializePolicyFlag(input)).toEqual({ id: "report-7" });
    expect(execute).toHaveBeenCalledOnce();
    const { sql, params } = query();
    expect(sql).not.toContain(";");
    expect(sql).toContain('INSERT INTO "reports"');
    expect(sql).toContain('UPDATE "members"');
    expect(sql).toContain('INSERT INTO "moderation_audit"');
    expect(sql).toContain(
      "ON CONFLICT (room_id, message_id) WHERE reporter_member_id IS NULL DO NOTHING",
    );
    expect(sql).toContain("RETURNING id, reported_member_id");
    expect(params).toEqual([
      input.roomId,
      "flag:campus-live:7",
      input.reportedMemberId,
      input.snippet,
      input.reason,
      "Automatic: repeated blocked messages.",
      true,
      JSON.stringify({ handle: input.pseudonym, flagId: 7 }),
    ]);
  });

  it("gates both mirror writes on the newly inserted report and audit on suspension", async () => {
    await materializePolicyFlag(input);
    const normalized = query().sql.replace(/\s+/g, " ");
    expect(normalized).toContain(
      'FROM inserted_report WHERE "members"."id" = inserted_report.reported_member_id AND $7',
    );
    expect(normalized).toContain(
      "FROM inserted_report INNER JOIN suspended_member ON suspended_member.id = inserted_report.reported_member_id",
    );
    expect(normalized).toContain(
      "SELECT 'auto_suspend', NULL, 'console', 'member', inserted_report.reported_member_id::text, inserted_report.id, $8::jsonb",
    );
    expect(normalized).toContain("SELECT id FROM inserted_report");
  });

  it("binds ordinary flags to a false suspension guard", async () => {
    await materializePolicyFlag({ ...input, autoSuspended: false });
    expect(query().params[6]).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns a completed duplicate without another standalone database operation", async () => {
    execute.mockResolvedValue({ rows: [] });
    expect(await materializePolicyFlag(input)).toBeNull();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps all external values out of SQL text", async () => {
    const hostile = "'; SELECT secret FROM members; --";
    await materializePolicyFlag({
      ...input,
      snippet: hostile,
      reason: hostile,
    });
    expect(query().sql).not.toContain(hostile);
    expect(query().params).toContain(hostile);
  });

  it("propagates any statement failure so the drain cannot acknowledge it", async () => {
    const failure = new Error("atomic statement failed");
    execute.mockRejectedValueOnce(failure);
    await expect(materializePolicyFlag(input)).rejects.toBe(failure);
    expect(execute).toHaveBeenCalledOnce();
  });
});
