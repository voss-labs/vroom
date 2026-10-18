/**
 * The V Rooms wire contract. Imported by the Durable Object and by the browser
 * client, so the two cannot drift. Keep it free of runtime dependencies.
 */

export const PROTOCOL_ID = "v-rooms.v1";

/** Newest-messages page size on join, and the backfill page size. */
export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

/**
 * A message that was broadcast but never written to the store (VRIP-10). It has
 * no `seq` because `seq` is the store's own primary key, which is exactly what
 * makes this type safe: every frame that can come out of the message table is
 * typed `Msg`, so backfill and history cannot carry one of these by accident.
 */
export interface EphemeralMsg {
  id: string;
  who: string;
  body: string;
  at: number;
}

export interface Msg extends EphemeralMsg {
  seq: number;
}

/**
 * How long a client shows an unstored message before removing it (VRIP-10).
 * Defined once, here, because this module is the one both the Durable Object
 * and the browser import. Sixty rather than thirty: thirty is not long enough
 * to actually save a number somebody deliberately gave you.
 */
export const EPHEMERAL_TTL_MS = 60_000;

/**
 * How long a stored message lives in the room and in the Durable Object SQLite
 * database before it disappears and is hard-deleted (VRIP-15). Forty-eight
 * hours keeps yesterday and today in scrollback without turning a campus room
 * into a permanent archive.
 */
export const MESSAGE_TTL_MS = 48 * 60 * 60_000;

export type SystemTone = "join" | "warn" | "dead";

/**
 * Who took a message out of the room (VRIP-11). Two deletions now exist and any
 * surface showing one has to be honest about which it is showing, so the actor
 * travels with the frame rather than being inferred at the far end.
 */
export type DeletedBy = "author" | "moderator";

export type ClientFrame =
  /** `confirmed` records that the sender saw VRIP-09's dialog and went ahead. */
  | { t: "send"; body: string; confirmed?: boolean }
  | { t: "history"; before: number; limit?: number }
  /**
   * An author withdrawing their own message (VRIP-11). It carries the message
   * id and nothing else: the handle comes from the socket's attachment inside
   * the room object, so there is no field here for a client to lie in.
   */
  | { t: "withdraw"; id: string };

export type ServerFrame =
  | {
      t: "ready";
      pseudonym: string;
      room: string;
      killed: boolean;
      count: number;
      members: string[];
      messages: Msg[];
      hasMore: boolean;
    }
  | { t: "message"; m: Msg }
  /** Delivered live, never stored, removed by the client after the TTL. */
  | { t: "ephemeral"; m: EphemeralMsg }
  | { t: "deleted"; id: string; by: DeletedBy }
  | { t: "presence"; count: number; members: string[] }
  | { t: "room"; killed: boolean; at: number }
  | { t: "system"; tone: SystemTone; text: string }
  | { t: "history"; messages: Msg[]; hasMore: boolean }
  | { t: "error"; code: SocketErrorCode; message: string; retryAfter?: number };

export type SocketErrorCode =
  | "rate_limited"
  | "room_closed"
  | "too_long"
  | "empty"
  | "suspended"
  | "blocked"
  | "not_author"
  | "bad_frame";

/** Close codes are part of the contract (VRIP-07). */
export const CLOSE = {
  NORMAL: 1000,
  TOKEN_EXPIRED: 4001,
  BAD_TOKEN: 4002,
  SUSPENDED: 4003,
} as const;

/** What each socket persists across hibernation. Kept short on purpose. */
export interface SocketAttachment {
  v: 1;
  p: string;
  j: number;
}

export function isSocketAttachment(value: unknown): value is SocketAttachment {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as SocketAttachment).v === 1 &&
    typeof (value as SocketAttachment).p === "string"
  );
}

export function parseClientFrame(raw: string): ClientFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const frame = parsed as Record<string, unknown>;

  if (frame.t === "send" && typeof frame.body === "string") {
    return { t: "send", body: frame.body, confirmed: frame.confirmed === true };
  }
  if (frame.t === "history" && typeof frame.before === "number") {
    const limit = typeof frame.limit === "number" ? frame.limit : undefined;
    return { t: "history", before: frame.before, limit };
  }
  // Only the id is read across. Any handle a client attaches to this frame is
  // dropped here rather than being carried into the room object to be ignored
  // there (VRIP-11).
  if (frame.t === "withdraw" && typeof frame.id === "string") {
    return { t: "withdraw", id: frame.id };
  }
  return null;
}

export function clampLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) {
    return PAGE_SIZE;
  }
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}
