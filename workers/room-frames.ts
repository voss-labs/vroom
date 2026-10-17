/**
 * What the room object does with an inbound client frame: the two handlers, and
 * every gate in front of them.
 *
 * Split out of `room-do.ts` because this is where the content policy lives —
 * VRIP-09's block and VRIP-10's write exclusion are both decisions about one
 * outbound message, and reading them next to the socket lifecycle made both
 * harder to check. Free functions taking the state rather than methods, the
 * same way `room-broadcast.ts` does, because under hibernation the object is
 * evicted and nothing may be closed over.
 */

import { numberVar } from "./env";
import * as policyStore from "./policy-store";
import { broadcast, closeQuietly, fail, sendTo } from "./room-broadcast";
import { CLOSE, clampLimit } from "./protocol";
import * as db from "./room-sql";

/**
 * A history frame is a scan plus a serialisation of up to MAX_PAGE_SIZE rows,
 * so it is the more expensive of the two and the one worth budgeting: the
 * object is single-threaded, and a client looping history starves message
 * delivery, presence and the moderator's setKilled RPC for everyone else.
 *
 * The budget is a separate key, so backfilling a long scrollback never spends
 * the budget for speaking. The kill switch is deliberately not a gate here:
 * a closed room stays readable ("You can read, you cannot post") and the ready
 * frame already carries a page of history to a killed room.
 */
export function handleHistory(
  sql: SqlStorage,
  env: Env,
  ws: WebSocket,
  pseudonym: string,
  before: number,
  limit?: number,
): void {
  if (db.isSuspended(sql, pseudonym)) {
    closeQuietly(ws, CLOSE.SUSPENDED, "suspended");
    return;
  }

  const perMinute = numberVar(env.RATE_LIMIT_HISTORY_PER_MINUTE, 30);
  const verdict = db.checkRate(
    sql,
    `history:${pseudonym}`,
    perMinute,
    Date.now(),
  );
  if (!verdict.allowed) {
    const slow = "You are requesting history too quickly.";
    fail(ws, "rate_limited", slow, verdict.retryAfter);
    return;
  }

  const page = db.messagesBefore(sql, before, clampLimit(limit));
  sendTo(ws, {
    t: "history",
    messages: page.messages,
    hasMore: page.hasMore,
  });
}

/**
 * An author withdrawing their own message (VRIP-11).
 *
 * `pseudonym` is the socket's own, read from its attachment by the caller. The
 * frame's only field is the message id, so there is nothing here that a client
 * could substitute for the handle the room already knows.
 *
 * The kill switch gates this the same way it gates sending. A closed room is a
 * moderator responding to something, and that is the one moment where letting
 * everyone empty their own history would work directly against them.
 *
 * The budget is spent before the row is read, so probing ids for someone else's
 * message costs the same as speaking.
 */
export function handleWithdraw(
  ctx: DurableObjectState,
  sql: SqlStorage,
  env: Env,
  ws: WebSocket,
  pseudonym: string,
  id: string,
): void {
  if (db.isSuspended(sql, pseudonym)) {
    closeQuietly(ws, CLOSE.SUSPENDED, "suspended");
    return;
  }
  if (db.readRoomState(sql).killed) {
    fail(ws, "room_closed", "The room is closed.");
    return;
  }

  const now = Date.now();
  const limit = numberVar(env.RATE_LIMIT_MESSAGES_PER_MINUTE, 20);
  const verdict = db.checkRate(sql, pseudonym, limit, now);
  if (!verdict.allowed) {
    fail(
      ws,
      "rate_limited",
      "You are sending too quickly.",
      verdict.retryAfter,
    );
    return;
  }

  const message = db.findMessage(sql, id);
  // Nothing to withdraw: an unknown id, or an ephemeral message that was never
  // written down (VRIP-10). Neither is an error worth a refusal frame, and
  // neither tells the sender anything about a message that is not theirs.
  if (!message) return;

  if (message.who !== pseudonym) {
    fail(ws, "not_author", "You can only withdraw your own messages.");
    return;
  }

  // Idempotent: an already-withdrawn message changes nothing and broadcasts
  // nothing, so a double click cannot produce two frames.
  if (db.softDeleteMessage(sql, id, now, "author")) {
    broadcast(ctx, { t: "deleted", id, by: "author" });
  }
}

export function handleSend(
  ctx: DurableObjectState,
  sql: SqlStorage,
  env: Env,
  ws: WebSocket,
  pseudonym: string,
  raw: string,
  confirmed: boolean,
): void {
  if (db.isSuspended(sql, pseudonym)) {
    closeQuietly(ws, CLOSE.SUSPENDED, "suspended");
    return;
  }
  if (db.readRoomState(sql).killed) {
    fail(ws, "room_closed", "The room is closed.");
    return;
  }

  const body = raw.trim();
  if (!body) {
    fail(ws, "empty", "Nothing to send.");
    return;
  }
  const maxChars = numberVar(env.MESSAGE_MAX_CHARS, 500);
  if (body.length > maxChars) {
    fail(ws, "too_long", `Messages are limited to ${maxChars} characters.`);
    return;
  }

  const now = Date.now();
  const limit = numberVar(env.RATE_LIMIT_MESSAGES_PER_MINUTE, 20);
  const verdict = db.checkRate(sql, pseudonym, limit, now);
  if (!verdict.allowed) {
    const slow = "You are sending too quickly.";
    fail(ws, "rate_limited", slow, verdict.retryAfter);
    return;
  }

  const screened = policyStore.screen(sql, pseudonym, body, confirmed, now);
  if (screened.blocked) {
    fail(ws, "blocked", screened.reason ?? "That message was not sent.");
    // The suspension row is already written. It takes effect on the next
    // frame rather than closing this socket, so the sender reads the refusal
    // that explains why before the room stops accepting them.
    return;
  }

  // VRIP-10, and the exclusion is here rather than in any query: a personal
  // data message is delivered to the people it was for and `insertMessage` is
  // never reached, so there is no row to filter out of a backfill later. It
  // has no seq for the same reason, which is why it rides its own frame.
  if (screened.ephemeral) {
    broadcast(ctx, {
      t: "ephemeral",
      m: { id: crypto.randomUUID(), who: pseudonym, body, at: now },
    });
    return;
  }

  const msg = db.insertMessage(sql, {
    id: crypto.randomUUID(),
    pseudonym,
    body,
    createdAt: now,
  });
  broadcast(ctx, { t: "message", m: msg });
}
