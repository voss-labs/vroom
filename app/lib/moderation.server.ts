import {
  findMemberById,
  findMemberByPseudonym,
  setSuspended,
  type MemberRecord,
} from "~/db/queries/members";
import { findReport, setReportStatus } from "~/db/queries/reports";
import { writeAudit } from "~/db/queries/audit";
import { getRoom, RoomUnreachable, type RoomStub } from "~/lib/room.server";
import { ROOM_IDS, isRoomId, type RoomId } from "~/lib/rooms";
import { ModerationError } from "~/lib/require-role.server";
import {
  requireCurrentModerator,
  type ModActor,
} from "~/lib/moderation-actor.server";
import type { ModIntent, ModResult } from "~/lib/moderation-contract";

export type { ModIntent, ModResult } from "~/lib/moderation-contract";

export type { ModActor } from "~/lib/moderation-actor.server";

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
  handle?: string;
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
  if ((intent === "suspend" || intent === "restore") && fields.handle) {
    const target = await findMemberByPseudonym(fields.handle);
    if (!target && !(intent === "suspend" && fields.reportId)) {
      throw new ModerationError("member_not_found", "No such handle.", 404);
    }
    fields = { ...fields, memberId: target?.id ?? null };
  }

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

  await setReportStatus(report.id, "resolved", null);
  await writeAudit({
    action: "delete_message",
    actorMemberId: null,
    actorKind: actor.kind,
    details: { cliSessionId: actor.sessionId },
    targetType: "message",
    targetId: report.messageId,
    reportId: report.id,
  });
  return { intent: "delete_message", ok: true };
}

async function suspend(actor: ModActor, fields: ModFields): Promise<ModResult> {
  const member = fields.reportId
    ? await requireReportTarget(fields.reportId, fields.memberId)
    : await requireMember(fields.memberId);
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
  if (fields.reportId) await setReportStatus(fields.reportId, "resolved", null);
  await writeAudit({
    action: "suspend",
    actorMemberId: null,
    actorKind: actor.kind,
    targetType: "member",
    targetId: member.id,
    reportId: fields.reportId ?? null,
    details: {
      cliSessionId: actor.sessionId,
      handle: member.pseudonym,
      reason: fields.reason ?? null,
    },
  });
  return { intent: "suspend", ok: true };
}

async function requireReportTarget(
  reportId: string,
  selectedId: string | null | undefined,
): Promise<MemberRecord> {
  const report = await requireReport(reportId);
  const member = report.reportedMemberId
    ? await findMemberById(report.reportedMemberId)
    : null;
  if (!member || member.deletedAt !== null || !member.pseudonym) {
    throw new ModerationError(
      "report_target_unavailable",
      "That report has no current account to suspend.",
      409,
    );
  }
  if (member.id !== selectedId) {
    throw new ModerationError(
      "report_target_mismatch",
      "That account is not the report's linked target.",
      409,
    );
  }
  return member;
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
    actorMemberId: null,
    actorKind: actor.kind,
    targetType: "member",
    targetId: member.id,
    details: { cliSessionId: actor.sessionId, handle: member.pseudonym },
  });
  return { intent: "restore", ok: true };
}

async function dismissReport(
  actor: ModActor,
  fields: ModFields,
): Promise<ModResult> {
  const report = await requireReport(fields.reportId);
  const changed = await setReportStatus(report.id, "dismissed", null);
  if (!changed) {
    throw new ModerationError(
      "already_resolved",
      "That report is already closed.",
      409,
    );
  }
  await writeAudit({
    action: "dismiss_report",
    actorMemberId: null,
    actorKind: actor.kind,
    details: { cliSessionId: actor.sessionId },
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
  const by = `cli:${actor.sessionId}`;
  const results = await everyRoom((stub) => stub.setKilled(killed, by));
  const at = Math.max(...results.map((result) => result.at));
  await writeAudit({
    action: killed ? "room_close" : "room_open",
    actorMemberId: null,
    actorKind: actor.kind,
    targetType: "room",
    targetId: "all",
    details: {
      cliSessionId: actor.sessionId,
      ...(fields.reason ? { reason: fields.reason } : {}),
    },
  });
  return { intent: "set_room_state", killed, at };
}
