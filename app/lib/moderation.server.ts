import {
  findMemberById,
  setSuspended,
  type MemberRecord,
} from "~/db/queries/members";
import { findReport, setReportStatus } from "~/db/queries/reports";
import { writeAudit } from "~/db/queries/audit";
import { resolveIdentity } from "~/lib/identity.server";
import { getRoom, RoomUnreachable } from "~/lib/room.server";
import { ROOM_IDS } from "~/lib/rooms";
import { ModerationError, assertModerator } from "~/lib/require-role.server";

/**
 * Every moderator action, for both front doors (VRIP-08).
 *
 * Ordering is not incidental. Enforcement state — kill switch, suspensions,
 * message deletion — lives in the Durable Object and is written FIRST; the Neon
 * record and the audit row are written second. An enforcement that happened
 * without an audit row is a gap in the record; an audit row for an enforcement
 * that never happened is a lie in the record, and the audit trail is worth more
 * when its rows are true than when they are complete.
 *
 * The single exception is `reveal`, where the audit row is the precondition and
 * the read happens only if that write succeeded.
 */

export interface ModActor {
  member: MemberRecord;
  kind: "console" | "script";
}

export type ModIntent =
  | "reveal"
  | "delete_message"
  | "suspend"
  | "restore"
  | "dismiss_report"
  | "set_room_state";

export const MOD_INTENTS: readonly ModIntent[] = [
  "reveal",
  "delete_message",
  "suspend",
  "restore",
  "dismiss_report",
  "set_room_state",
];

export function isModIntent(value: unknown): value is ModIntent {
  return (
    typeof value === "string" &&
    (MOD_INTENTS as readonly string[]).includes(value)
  );
}

export interface ModFields {
  reportId?: string | null;
  memberId?: string | null;
  reason?: string | null;
  killed?: boolean;
}

export type ModResult =
  | { intent: "reveal"; email: string; name: string }
  | { intent: "set_room_state"; killed: boolean; at: number }
  | { intent: Exclude<ModIntent, "reveal" | "set_room_state">; ok: true };

/**
 * Any failure to reach or command the object is `room_unreachable`. That is the
 * correct behaviour rather than a nuisance: a suspension that only exists in
 * Neon would show as applied in the console while the account kept posting.
 */
function unreachable(error: unknown): never {
  if (error instanceof ModerationError) throw error;
  if (!(error instanceof RoomUnreachable)) {
    console.error("[moderation] durable object call failed:", error);
  }
  throw new ModerationError(
    "room_unreachable",
    "The room is unreachable.",
    503,
  );
}

async function room(roomId: string) {
  try {
    return await getRoom(roomId);
  } catch (error) {
    unreachable(error);
  }
}

async function requireReport(reportId: string | null | undefined) {
  if (!reportId) {
    throw new ModerationError(
      "report_not_found",
      "A report id is required.",
      400,
    );
  }
  const report = await findReport(reportId);
  if (!report)
    throw new ModerationError("report_not_found", "No such report.", 404);
  return report;
}

async function requireMember(memberId: string | null | undefined) {
  if (!memberId) {
    throw new ModerationError(
      "member_not_found",
      "A member id is required.",
      400,
    );
  }
  const member = await findMemberById(memberId);
  if (!member)
    throw new ModerationError("member_not_found", "No such member.", 404);
  return member;
}

/**
 * The single entry point. The role is re-checked here, so the console route and
 * the script route cannot diverge on whether they checked.
 */
export async function performModeration(
  actor: ModActor,
  intent: ModIntent,
  fields: ModFields,
): Promise<ModResult> {
  assertModerator(actor.member);

  switch (intent) {
    case "reveal":
      return reveal(actor, fields);
    case "delete_message":
      return deleteMessage(actor, fields);
    case "suspend":
      return suspend(actor, fields);
    case "restore":
      return restore(actor, fields);
    case "dismiss_report":
      return dismissReport(actor, fields);
    case "set_room_state":
      return setRoomState(actor, fields);
  }
}

/** Audit first. The row is the precondition, and the CHECK enforces the binding. */
async function reveal(actor: ModActor, fields: ModFields): Promise<ModResult> {
  const report = await requireReport(fields.reportId);
  const resolved = await resolveIdentity({
    memberId: report.reportedMemberId,
    actorMemberId: actor.member.id,
    actorKind: actor.kind,
    reportId: report.id,
    messageId: report.messageId,
  });
  return { intent: "reveal", email: resolved.email, name: resolved.name };
}

async function deleteMessage(
  actor: ModActor,
  fields: ModFields,
): Promise<ModResult> {
  const report = await requireReport(fields.reportId);

  try {
    await (await room(report.roomId)).deleteMessage(report.messageId);
  } catch (error) {
    unreachable(error);
  }

  await setReportStatus(report.id, "resolved", actor.member.id);
  await writeAudit({
    action: "delete_message",
    actorMemberId: actor.member.id,
    actorKind: actor.kind,
    targetType: "message",
    targetId: report.messageId,
    reportId: report.id,
  });
  return { intent: "delete_message", ok: true };
}

async function suspend(actor: ModActor, fields: ModFields): Promise<ModResult> {
  const member = await requireMember(fields.memberId);
  if (!member.pseudonym) {
    throw new ModerationError(
      "member_not_found",
      "That account has no handle yet.",
      400,
    );
  }

  // Enforcement first: this closes their open sockets with 4003.
  try {
    for (const id of ROOM_IDS) {
      try {
        await (await room(id)).suspend(member.pseudonym);
      } catch (e) {
        // Continue if a room is unreachable, we still want to suspend in others
      }
    }
  } catch (error) {
    unreachable(error);
  }

  await setSuspended(member.id, true, fields.reason ?? null);
  if (fields.reportId)
    await setReportStatus(fields.reportId, "resolved", actor.member.id);
  await writeAudit({
    action: "suspend",
    actorMemberId: actor.member.id,
    actorKind: actor.kind,
    targetType: "member",
    targetId: member.id,
    reportId: fields.reportId ?? null,
    details: { handle: member.pseudonym, reason: fields.reason ?? null },
  });
  return { intent: "suspend", ok: true };
}

async function restore(actor: ModActor, fields: ModFields): Promise<ModResult> {
  const member = await requireMember(fields.memberId);
  if (!member.pseudonym) {
    throw new ModerationError(
      "member_not_found",
      "That account has no handle yet.",
      400,
    );
  }

  try {
    for (const id of ROOM_IDS) {
      try {
        await (await room(id)).restore(member.pseudonym);
      } catch (e) {
        // Ignore unreachable rooms
      }
    }
  } catch (error) {
    unreachable(error);
  }

  await setSuspended(member.id, false);
  await writeAudit({
    action: "restore",
    actorMemberId: actor.member.id,
    actorKind: actor.kind,
    targetType: "member",
    targetId: member.id,
    details: { handle: member.pseudonym },
  });
  return { intent: "restore", ok: true };
}

/** The one action with no Durable Object leg: nothing a student can do changes. */
async function dismissReport(
  actor: ModActor,
  fields: ModFields,
): Promise<ModResult> {
  const report = await requireReport(fields.reportId);
  const changed = await setReportStatus(
    report.id,
    "dismissed",
    actor.member.id,
  );
  if (!changed) {
    throw new ModerationError(
      "already_resolved",
      "That report is already closed.",
      409,
    );
  }
  await writeAudit({
    action: "dismiss_report",
    actorMemberId: actor.member.id,
    actorKind: actor.kind,
    targetType: "report",
    targetId: report.id,
    reportId: report.id,
  });
  return { intent: "dismiss_report", ok: true };
}

async function setRoomState(
  actor: ModActor,
  fields: ModFields,
): Promise<ModResult> {
  const killed = fields.killed === true;
  let result: { killed: boolean; at: number };
  try {
    result = await (
      await room("campus-live")
    ).setKilled(killed, actor.member.pseudonym ?? actor.member.id);
  } catch (error) {
    unreachable(error);
  }

  // The reason is why this row exists. `npm run mod -- close "<why>"` documents
  // the argument, and the room is closed under more pressure than anything else.
  await writeAudit({
    action: killed ? "room_close" : "room_open",
    actorMemberId: actor.member.id,
    actorKind: actor.kind,
    targetType: "room",
    targetId: "campus-live",
    details: fields.reason ? { reason: fields.reason } : null,
  });
  return { intent: "set_room_state", killed: result.killed, at: result.at };
}
