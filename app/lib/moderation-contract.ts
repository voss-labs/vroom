export const MOD_PAGE_SIZE = 25;
export const MOD_MAX_PAGE = 9999;

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

export interface ReportItem {
  id: string;
  messageId: string;
  snapshot: string;
  reason: string | null;
  handle: string | null;
  roomId: string;
  status: string;
  createdAt: string;
}

export interface ReportsView extends Page<ReportItem> {
  drain: { complete: boolean; unreachableRooms: string[] };
}

export interface AccountItem {
  handle: string;
  suspended: boolean;
  suspendedReason: string | null;
}

export interface AuditItem {
  id: string;
  action: string;
  actorHandle: string | null;
  actorKind: string;
  targetType: string;
  targetId: string | null;
  reportId: string | null;
  details: { handle?: string; reason?: string } | null;
  createdAt: string;
}

export type RoomStatus =
  | { roomId: string; reachable: false }
  | {
      roomId: string;
      reachable: true;
      online: number;
      messages: number;
      killed: boolean;
      killedAt: number | null;
      killedBy: string | null;
    };

export interface StatusView {
  rooms: RoomStatus[];
  aggregate: { online: number; messages: number; killed: boolean } | null;
}

export type ModIntent =
  | "delete_message"
  | "suspend"
  | "restore"
  | "dismiss_report"
  | "set_room_state";

export type ModReadAction = "reports" | "accounts" | "audit" | "status";
export type ModAction = ModIntent | ModReadAction;

export type ModResult =
  | { intent: "set_room_state"; killed: boolean; at: number }
  | { intent: Exclude<ModIntent, "set_room_state">; ok: true };

export interface ModError {
  code: string;
  message: string;
  partial?: boolean;
  rooms?: Array<{ roomId: string; reachable: boolean }>;
}
