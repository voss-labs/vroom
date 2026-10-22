import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/pg-proxy";
import type { Query } from "drizzle-orm";
import * as tables from "~/db/schema";
import { prepared, runSql, schema } from "./policy-fixture";
import { reportFixtureSql, reportId } from "./report-fixture";

const queries: Query[] = [];
vi.mock("~/db", async () => ({
  db: drizzle(
    async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [["20000000-0000-4000-8000-000000000001"]] };
    },
    { schema: tables },
  ),
}));
const { setReportStatus } = await import("~/db/queries/reports");
const { writeAudit } = await import("~/db/queries/audit");
const sessionId = "10000000-0000-4000-8000-000000000001";
const migration = (name: string) =>
  readFileSync(
    new URL(`../../app/db/migrations/${name}`, import.meta.url),
    "utf8",
  );

beforeAll(async () => {
  await runSql(`CREATE SCHEMA "${schema}";`, { scope: false });
  await runSql(reportFixtureSql);
  await runSql(migration("0004_retained_report_author.sql"));
  await runSql(`CREATE TABLE moderation_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), action text NOT NULL,
    actor_member_id uuid REFERENCES members(id) ON DELETE SET NULL,
    actor_kind text NOT NULL CHECK (actor_kind IN ('console', 'script')),
    target_type text NOT NULL, target_id text, report_id uuid REFERENCES reports(id),
    details jsonb, created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reveal_must_be_bound CHECK (action <> 'reveal' OR report_id IS NOT NULL)
  );`);
  await runSql(migration("0005_cli_sessions.sql"));
});
afterAll(async () => {
  await runSql(`DROP SCHEMA "${schema}" CASCADE;`, { scope: false });
});

describe("CLI session audit on existing report schema", () => {
  it("resolves with no member and retains audit correlation after session cleanup", async () => {
    await runSql(
      `INSERT INTO cli_sessions(id, token_hash, origin) VALUES ('${sessionId}', repeat('a',64), 'https://vrooms.test');`,
    );
    await setReportStatus(reportId, "resolved", null);
    await runSql(prepared(queries[queries.length - 1]));
    await writeAudit({
      action: "delete_message",
      actorMemberId: null,
      actorKind: "script",
      targetType: "message",
      targetId: "linked-message",
      reportId,
      details: { cliSessionId: sessionId },
    });
    await runSql(prepared(queries[queries.length - 1]));
    await runSql("DELETE FROM cli_sessions;");
    const row = JSON.parse(
      await runSql(`SELECT json_build_object('status', reports.status, 'resolved', reports.resolved_at IS NOT NULL,
      'resolver', reports.resolved_by, 'actor', moderation_audit.actor_member_id, 'kind', moderation_audit.actor_kind,
      'session', moderation_audit.details->>'cliSessionId', 'evidence', reports.message_snapshot)
      FROM reports JOIN moderation_audit ON moderation_audit.report_id = reports.id WHERE reports.id = '${reportId}';`),
    );
    expect(row).toEqual({
      status: "resolved",
      resolved: true,
      resolver: null,
      actor: null,
      kind: "script",
      session: sessionId,
      evidence: "retained body",
    });
    expect(await runSql("SELECT count(*) FROM members;")).toBe("5");
    await expect(
      runSql(
        "INSERT INTO moderation_audit(action, actor_kind, target_type) VALUES ('reveal', 'console', 'member');",
      ),
    ).rejects.toThrow("reveal_must_be_bound");
  });
});
