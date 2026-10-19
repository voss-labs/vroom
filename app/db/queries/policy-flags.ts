import { sql } from "drizzle-orm";

import { db } from "~/db";
import { members, moderationAudit, reports } from "~/db/schema";

export interface PolicyFlagInput {
  roomId: string;
  flagId: number;
  reportedMemberId: string;
  pseudonym: string;
  snippet: string;
  reason: string;
  autoSuspended: boolean;
}

export async function materializePolicyFlag(
  input: PolicyFlagInput,
): Promise<{ id: string } | null> {
  const messageId = `flag:${input.roomId}:${input.flagId}`;
  const details = JSON.stringify({
    handle: input.pseudonym,
    flagId: input.flagId,
  });
  const result = await db.execute<{ id: string }>(sql`
    WITH inserted_report AS (
      INSERT INTO ${reports}
        (room_id, message_id, reported_member_id, reporter_member_id, message_snapshot, reason)
      VALUES
        (${input.roomId}, ${messageId}, ${input.reportedMemberId}, NULL, ${input.snippet}, ${input.reason})
      ON CONFLICT (room_id, message_id) WHERE reporter_member_id IS NULL DO NOTHING
      RETURNING id, reported_member_id
    ), suspended_member AS (
      UPDATE ${members}
      SET suspended_at = now(), suspended_reason = ${"Automatic: repeated blocked messages."}
      FROM inserted_report
      WHERE ${members.id} = inserted_report.reported_member_id AND ${input.autoSuspended}
      RETURNING ${members.id}
    ), inserted_audit AS (
      INSERT INTO ${moderationAudit}
        (action, actor_member_id, actor_kind, target_type, target_id, report_id, details)
      SELECT 'auto_suspend', NULL, 'console', 'member', inserted_report.reported_member_id::text,
        inserted_report.id, ${details}::jsonb
      FROM inserted_report
      INNER JOIN suspended_member ON suspended_member.id = inserted_report.reported_member_id
      RETURNING id
    )
    SELECT id FROM inserted_report
  `);
  return result.rows[0] ?? null;
}
