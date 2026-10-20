import {
  findMemberById,
  setSuspended,
  type MemberRecord,
} from "~/db/queries/members";
import { findReport, setReportStatus } from "~/db/queries/reports";
import { writeAudit } from "~/db/queries/audit";
import { getRoom, RoomUnreachable, type RoomStub } from "~/lib/room.server";
import { ROOM_IDS, isRoomId, type RoomId } from "~/lib/rooms";
import { ModerationError } from "~/lib/require-role.server";
import { requireCurrentModerator } from "~/lib/moderation-actor.server";
import type { ModIntent, ModResult } from "~/lib/moderation-contract";

export type { ModIntent, ModResult } from "~/lib/moderation-contract";

export interface ModActor {
  member: MemberRecord;
  kind: "console" | "script";
}

export const MOD_INTENTS: readonly ModIntent[] = [
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

export class PartialModerationError extends ModerationError {
  readonly partial = true;

  constructor(readonly rooms: Array<{ roomId: string; reachable: boolean }>) {
    super(
      "room_unreachable",
      "Some rooms could not be updated. Enforcement may already have happened in other rooms.",
      503,
    );
  }
}

function unreachable(error: unknown): never {
  if (error instanceof ModerationError) throw error;
  if (!(error instanceof RoomUnreachable)) {
    console.error("[moderation] durable object call failed");
  }
  throw new ModerationError(
    "room_unreachable",
    "The room is unreachable.",
    503,
  );
}

async function room(roomId: RoomId) {
  try {
    return await getRoom(roomId);
  } catch (error) {
    unreachable(error);
  }
}

async function everyRoom<T>(fn: (room: RoomStub) => Promise<T>): Promise<T[]> {
  const outcomes = await Promise.allSettled(
    ROOM_IDS.map(async (id) => fn(await room(id))),
  );
  if (outcomes.some((outcome) => outcome.status === "rejected")) {
    throw new PartialModerationError(
      ROOM_IDS.map((roomId, index) => ({
        roomId,
        reachable: outcomes[index].status === "fulfilled",
      })),
    );
  }
  return outcomes.map(
    (outcome) => (outcome as PromiseFulfilledResult<T>).value,
  );
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

export async function performModeration(
  actor: ModActor,
  intent: ModIntent,
  fields: ModFields,
): Promise<ModResult> {
  actor = await requireCurrentModerator(actor);

  switch (intent) {
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

async function deleteMessage(
  actor: ModActor,
  fields: ModFields,
): Promise<ModResult> {
  const report = await requireReport(fields.reportId);
  if (!isRoomId(report.roomId)) {
    throw new ModerationError(
      "room_unreachable",
      "That report names a room this deployment does not serve.",
      503,
    );
  }

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
  const handle = member.pseudonym;
  if (!handle) {
    throw new ModerationError(
      "member_not_found",
      "That account has no handle yet.",
      400,
    );
  }
  await everyRoom((stub) => stub.suspend(handle));

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
  const handle = member.pseudonym;
  if (!handle) {
    throw new ModerationError(
      "member_not_found",
      "That account has no handle yet.",
      400,
    );
  }

  await everyRoom((stub) => stub.restore(handle));

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
  const by = actor.member.pseudonym ?? "moderator";
  const results = await everyRoom((stub) => stub.setKilled(killed, by));
  const at = Math.max(...results.map((result) => result.at));
  await writeAudit({
    action: killed ? "room_close" : "room_open",
    actorMemberId: actor.member.id,
    actorKind: actor.kind,
    targetType: "room",
    targetId: "all",
    details: fields.reason ? { reason: fields.reason } : null,
  });
  return { intent: "set_room_state", killed, at };
}
