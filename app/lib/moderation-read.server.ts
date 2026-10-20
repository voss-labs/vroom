import { countAccounts, listAccounts } from "~/db/queries/members";
import { countReports, listReports } from "~/db/queries/reports";
import { countAudit, listAudit } from "~/db/queries/audit";
import { requireCurrentModerator } from "~/lib/moderation-actor.server";
import type { ModActor } from "~/lib/moderation.server";
import { MOD_PAGE_SIZE, MOD_MAX_PAGE } from "~/lib/moderation-contract";
import type {
  AccountItem,
  AuditItem,
  ModReadAction,
  Page,
  ReportItem,
  ReportsView,
  StatusView,
} from "~/lib/moderation-contract";
import { drainPolicyFlags } from "~/lib/policy.server";
import { ModerationError } from "~/lib/require-role.server";
import { readRoomStatus } from "~/lib/room.server";
import { ROOM_IDS } from "~/lib/rooms";

export function isModReadAction(value: unknown): value is ModReadAction {
  return (
    value === "reports" ||
    value === "accounts" ||
    value === "audit" ||
    value === "status"
  );
}

function pageNumber(value: unknown): number {
  if (value === undefined) return 0;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MOD_MAX_PAGE
  ) {
    throw new ModerationError(
      "bad_request",
      `Page must be a whole number between 0 and ${MOD_MAX_PAGE}.`,
      400,
    );
  }
  return value;
}

function pageView<T>(items: T[], page: number, total: number): Page<T> {
  return {
    items,
    page,
    pageSize: MOD_PAGE_SIZE,
    total,
    hasMore: (page + 1) * MOD_PAGE_SIZE < total,
  };
}

function auditDetails(value: unknown): AuditItem["details"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const details = value as Record<string, unknown>;
  const result: NonNullable<AuditItem["details"]> = {};
  if (typeof details.handle === "string") result.handle = details.handle;
  if (typeof details.reason === "string") result.reason = details.reason;
  return Object.keys(result).length ? result : null;
}

async function reportsPage(page: number): Promise<ReportsView> {
  let drain: ReportsView["drain"];
  try {
    const result = await drainPolicyFlags();
    drain = {
      complete: !result.unreachable,
      unreachableRooms: result.unreachableRooms,
    };
  } catch {
    drain = { complete: false, unreachableRooms: [...ROOM_IDS] };
  }
  const [reports, total] = await Promise.all([
    listReports(page, MOD_PAGE_SIZE),
    countReports(),
  ]);
  const items: ReportItem[] = reports.map((report) => ({
    id: report.id,
    messageId: report.messageId,
    snapshot: report.snapshot,
    reason: report.reason,
    handle: report.handle,
    roomId: report.roomId,
    status: report.status,
    createdAt: report.createdAt.toISOString(),
  }));
  return { ...pageView(items, page, total), drain };
}

async function accountsPage(page: number): Promise<Page<AccountItem>> {
  const [accounts, total] = await Promise.all([
    listAccounts(page, MOD_PAGE_SIZE),
    countAccounts(),
  ]);
  return pageView(
    accounts.map((account) => ({
      handle: account.handle,
      suspended: account.suspended,
      suspendedReason: account.suspendedReason,
    })),
    page,
    total,
  );
}

async function auditPage(page: number): Promise<Page<AuditItem>> {
  const [entries, total] = await Promise.all([
    listAudit(page, MOD_PAGE_SIZE),
    countAudit(),
  ]);
  return pageView(
    entries.map((entry) => ({
      id: entry.id,
      action: entry.action,
      actorHandle: entry.actorHandle,
      actorKind: entry.actorKind,
      targetType: entry.targetType,
      targetId: entry.targetId,
      reportId: entry.reportId,
      details: auditDetails(entry.details),
      createdAt: entry.createdAt.toISOString(),
    })),
    page,
    total,
  );
}

export async function readModeration(
  actor: ModActor,
  action: ModReadAction,
  body: Record<string, unknown>,
): Promise<ReportsView | Page<AccountItem> | Page<AuditItem> | StatusView> {
  await requireCurrentModerator(actor);
  if (action === "status") return readRoomStatus();
  const page = pageNumber(body.page);
  switch (action) {
    case "reports":
      return reportsPage(page);
    case "accounts":
      return accountsPage(page);
    case "audit":
      return auditPage(page);
  }
}
