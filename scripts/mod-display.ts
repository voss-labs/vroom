import { stripVTControlCharacters } from "node:util";
import type {
  AccountItem,
  AuditItem,
  ReportItem,
  ReportsView,
  StatusView,
} from "../app/lib/moderation-contract";

export function display(value: string): string {
  return stripVTControlCharacters(value).replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    "",
  );
}

export function reportText(report: ReportItem): string {
  return display(
    [
      `Report: ${report.id}`,
      `Message: ${report.messageId}`,
      `Handle: ${report.handle ?? "unavailable"}`,
      report.suspendHandle
        ? `Suspension target: ${report.suspendHandle}`
        : "Author account unavailable; suspension is not available.",
      `Room: ${report.roomId}`,
      `Status: ${report.status}`,
      `Created: ${report.createdAt}`,
      `Reason: ${report.reason ?? "not supplied"}`,
      "",
      "Retained message snapshot:",
      report.snapshot,
    ].join("\n"),
  );
}

export function accountText(account: AccountItem): string {
  return display(
    `Handle: ${account.handle}\nStatus: ${account.suspended ? "suspended" : "active"}\nSuspension reason: ${account.suspendedReason ?? "not supplied"}`,
  );
}

export function auditText(item: AuditItem): string {
  return display(
    [
      `${item.createdAt} | ${item.action}`,
      `Actor: ${item.actorHandle ?? "unavailable"} (${item.actorKind})`,
      `Target: ${item.targetType} ${item.targetId ?? "unavailable"}`,
      `Report: ${item.reportId ?? "none"}`,
      ...(item.details?.handle ? [`Handle: ${item.details.handle}`] : []),
      ...(item.details?.reason ? [`Reason: ${item.details.reason}`] : []),
    ].join("\n"),
  );
}

export function drainWarning(view: ReportsView): string | null {
  if (view.drain.complete) return null;
  return display(
    `Policy drain incomplete. Stored reports remain readable; automatic reports may still be pending in: ${view.drain.unreachableRooms.join(", ") || "unavailable rooms"}.`,
  );
}

export function statusText(view: StatusView): string {
  const lines = view.rooms.map((room) => {
    if (!room.reachable)
      return `${room.roomId}: unreachable; current state unknown`;
    return [
      `${room.roomId}: reachable; ${room.killed ? "closed" : "open"}`,
      `  ${room.online} online; ${room.messages} messages`,
      ...(room.killedAt !== null
        ? [`  Closed at: ${new Date(room.killedAt).toISOString()}`]
        : []),
      ...(room.killedBy !== null ? [`  Closed by: ${room.killedBy}`] : []),
    ].join("\n");
  });
  if (view.aggregate === null) {
    lines.push("Aggregate unavailable while any room is unreachable.");
  } else {
    lines.push(
      `Aggregate: ${view.aggregate.online} online; ${view.aggregate.messages} messages; ${view.aggregate.killed ? "all rooms closed" : "rooms open or mixed"}`,
    );
  }
  return display(lines.join("\n"));
}
