import { count, desc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "~/db";
import { members, moderationAudit } from "~/db/schema";
import type { ActorKind, AuditAction } from "~/db/schema";

const actorMember = alias(members, "actor_member");

export interface AuditEntry {
  id: string;
  action: string;
  actorHandle: string | null;
  actorKind: string;
  targetType: string;
  targetId: string | null;
  reportId: string | null;
  details: unknown;
  createdAt: Date;
}

export interface WriteAuditInput {
  action: AuditAction;
  actorMemberId: string | null;
  actorKind: ActorKind;
  targetType: "member" | "message" | "report" | "room";
  targetId?: string | null;
  reportId?: string | null;
  details?: Record<string, unknown> | null;
}

/**
 * The write throws on a CHECK violation rather than swallowing it — a reveal
 * with no report_id must fail loudly, because the row is the precondition for
 * the read that follows (VRIP-08).
 */
export async function writeAudit(
  input: WriteAuditInput,
): Promise<{ id: string }> {
  const rows = await db
    .insert(moderationAudit)
    .values({
      action: input.action,
      actorMemberId: input.actorMemberId,
      actorKind: input.actorKind,
      targetType: input.targetType,
      targetId: input.targetId ?? null,
      reportId: input.reportId ?? null,
      details: input.details ?? null,
    })
    .returning({ id: moderationAudit.id });

  if (!rows[0]) throw new Error("writeAudit: no row returned");
  return rows[0];
}

export async function listAudit(
  page = 0,
  pageSize = 25,
): Promise<AuditEntry[]> {
  return db
    .select({
      id: moderationAudit.id,
      action: moderationAudit.action,
      actorHandle: actorMember.pseudonym,
      actorKind: moderationAudit.actorKind,
      targetType: moderationAudit.targetType,
      targetId: moderationAudit.targetId,
      reportId: moderationAudit.reportId,
      details: moderationAudit.details,
      createdAt: moderationAudit.createdAt,
    })
    .from(moderationAudit)
    .leftJoin(actorMember, eq(moderationAudit.actorMemberId, actorMember.id))
    .orderBy(desc(moderationAudit.createdAt), desc(moderationAudit.id))
    .limit(pageSize)
    .offset(page * pageSize);
}

export async function countAudit(): Promise<number> {
  const rows = await db.select({ n: count() }).from(moderationAudit);
  return rows[0]?.n ?? 0;
}
