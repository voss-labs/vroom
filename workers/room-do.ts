import { DurableObject } from "cloudflare:workers";

import { numberVar } from "./env";
import {
  CLOSE,
  PAGE_SIZE,
  clampLimit,
  isSocketAttachment,
  parseClientFrame,
  type Msg,
  type ServerFrame,
  type SocketAttachment,
  type SystemTone,
} from "./protocol";
import * as db from "./room-sql";

/** Header the Worker sets after verifying the token. The binding is the boundary. */
export const PSEUDONYM_HEADER = "x-vrooms-pseudonym";

export interface RoomStats {
  total: number;
  since: number | null;
  peakToday: number;
  online: number;
}

export class RoomDurableObject extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      db.ensureSchema(this.sql);
    });
  }

  /* ---------------- connection lifecycle ---------------- */

  async fetch(request: Request): Promise<Response> {
    const pseudonym = request.headers.get(PSEUDONYM_HEADER);
    if (!pseudonym) {
      return new Response("missing pseudonym", { status: 400 });
    }
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    // Before ctx.acceptWebSocket, not after. An accepted socket carrying an
    // attachment fires webSocketClose when it is closed, which broadcasts a
    // departure line — so a suspended account reconnecting in a loop would
    // announce itself to the whole room for the life of its token.
    if (db.isSuspended(this.sql, pseudonym)) {
      return this.rejectSocket(CLOSE.SUSPENDED, "suspended");
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const attachment: SocketAttachment = { v: 1, p: pseudonym, j: Date.now() };

    // Hibernation: accept through ctx, never ws.accept(), or the object is
    // billed for the whole connection and in-memory state is assumed to survive.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);

    const url = new URL(request.url);
    const room = url.searchParams.get("room") || "campus-live";
    this.onJoin(server, pseudonym, room);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Plain accept and close, the way the upgrade guard rejects a bad token. */
  private rejectSocket(code: number, reason: string): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    server.close(code, reason);
    return new Response(null, { status: 101, webSocket: client });
  }

  private onJoin(server: WebSocket, pseudonym: string, room: string): void {
    const state = db.readRoomState(this.sql);
    const page = db.recentMessages(this.sql, PAGE_SIZE);
    const members = this.members();
    const now = Date.now();
    db.recordPeak(this.sql, db.utcDay(now), members.length);

    this.sendTo(server, {
      t: "ready",
      pseudonym,
      room,
      killed: state.killed,
      count: members.length,
      members,
      messages: page.messages,
      hasMore: page.hasMore,
    });

    // A second tab is the same student, so it is not a new arrival.
    const isFirstSocket = this.socketsFor(pseudonym).length === 1;
    if (isFirstSocket) {
      this.broadcast(
        { t: "system", tone: "join", text: `${pseudonym} joined` },
        server,
      );
    }
    this.broadcastPresence();
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") {
      this.sendTo(ws, {
        t: "error",
        code: "bad_frame",
        message: "Binary frames are not accepted.",
      });
      return;
    }
    const attachment = ws.deserializeAttachment();
    if (!isSocketAttachment(attachment)) {
      ws.close(CLOSE.BAD_TOKEN, "no attachment");
      return;
    }
    const frame = parseClientFrame(message);
    if (!frame) {
      this.sendTo(ws, {
        t: "error",
        code: "bad_frame",
        message: "Unrecognised frame.",
      });
      return;
    }

    if (frame.t === "history") {
      this.handleHistory(ws, attachment.p, frame.before, frame.limit);
      return;
    }

    this.handleSend(ws, attachment.p, frame.body);
  }

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
  private handleHistory(
    ws: WebSocket,
    pseudonym: string,
    before: number,
    limit?: number,
  ): void {
    if (db.isSuspended(this.sql, pseudonym)) {
      this.closeQuietly(ws, CLOSE.SUSPENDED, "suspended");
      return;
    }

    const perMinute = numberVar(this.env.RATE_LIMIT_HISTORY_PER_MINUTE, 30);
    const verdict = db.checkRate(
      this.sql,
      `history:${pseudonym}`,
      perMinute,
      Date.now(),
    );
    if (!verdict.allowed) {
      this.sendTo(ws, {
        t: "error",
        code: "rate_limited",
        message: "You are requesting history too quickly.",
        retryAfter: verdict.retryAfter,
      });
      return;
    }

    const page = db.messagesBefore(this.sql, before, clampLimit(limit));
    this.sendTo(ws, {
      t: "history",
      messages: page.messages,
      hasMore: page.hasMore,
    });
  }

  private handleSend(ws: WebSocket, pseudonym: string, raw: string): void {
    if (db.isSuspended(this.sql, pseudonym)) {
      this.closeQuietly(ws, CLOSE.SUSPENDED, "suspended");
      return;
    }
    if (db.readRoomState(this.sql).killed) {
      this.sendTo(ws, {
        t: "error",
        code: "room_closed",
        message: "The room is closed.",
      });
      return;
    }

    const body = raw.trim();
    if (!body) {
      this.sendTo(ws, {
        t: "error",
        code: "empty",
        message: "Nothing to send.",
      });
      return;
    }
    const maxChars = numberVar(this.env.MESSAGE_MAX_CHARS, 500);
    if (body.length > maxChars) {
      this.sendTo(ws, {
        t: "error",
        code: "too_long",
        message: `Messages are limited to ${maxChars} characters.`,
      });
      return;
    }

    const now = Date.now();
    const limit = numberVar(this.env.RATE_LIMIT_MESSAGES_PER_MINUTE, 20);
    const verdict = db.checkRate(this.sql, pseudonym, limit, now);
    if (!verdict.allowed) {
      this.sendTo(ws, {
        t: "error",
        code: "rate_limited",
        message: "You are sending too quickly.",
        retryAfter: verdict.retryAfter,
      });
      return;
    }

    const msg = db.insertMessage(this.sql, {
      id: crypto.randomUUID(),
      pseudonym,
      body,
      createdAt: now,
    });
    this.broadcast({ t: "message", m: msg });
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    void code;
    void reason;
    void wasClean;
    const attachment = ws.deserializeAttachment();
    const pseudonym = isSocketAttachment(attachment) ? attachment.p : null;
    // The socket is still listed until this handler returns, so exclude it.
    if (pseudonym && this.socketsFor(pseudonym, ws).length === 0) {
      this.broadcast(
        { t: "system", tone: "join", text: `${pseudonym} left` },
        ws,
      );
    }
    this.broadcastPresence(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastPresence(ws);
  }

  /* ---------------- presence ---------------- */

  /** Derived, never stored. Two tabs are one student. */
  private members(exclude?: WebSocket): string[] {
    const seen = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      const attachment = ws.deserializeAttachment();
      if (isSocketAttachment(attachment)) seen.add(attachment.p);
    }
    return [...seen].sort();
  }

  private socketsFor(pseudonym: string, exclude?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      if (ws === exclude) return false;
      const attachment = ws.deserializeAttachment();
      return isSocketAttachment(attachment) && attachment.p === pseudonym;
    });
  }

  private broadcastPresence(exclude?: WebSocket): void {
    const members = this.members(exclude);
    this.broadcast({ t: "presence", count: members.length, members }, exclude);
  }

  private closeQuietly(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closing. A second close is not a new fact.
    }
  }

  private sendTo(ws: WebSocket, frame: ServerFrame): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // A socket the edge has already dropped. Presence corrects on the next close.
    }
  }

  private broadcast(frame: ServerFrame, exclude?: WebSocket): void {
    const payload = JSON.stringify(frame);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      try {
        ws.send(payload);
      } catch {
        // See sendTo.
      }
    }
  }

  private system(tone: SystemTone, text: string): void {
    this.broadcast({ t: "system", tone, text });
  }

  /* ---------------- RPC, called by moderation.server.ts ---------------- */

  async getRoomState(): Promise<db.RoomState> {
    return db.readRoomState(this.sql);
  }

  async setKilled(
    killed: boolean,
    actor: string,
  ): Promise<{ killed: boolean; at: number }> {
    const at = Date.now();
    db.writeRoomState(this.sql, killed, actor, at);
    this.broadcast({ t: "room", killed, at });
    this.system(
      killed ? "dead" : "join",
      killed
        ? "A moderator closed the room. You can read, you cannot post."
        : "The room is open again.",
    );
    return { killed, at };
  }

  async suspend(pseudonym: string): Promise<void> {
    db.addSuspension(this.sql, pseudonym, Date.now());
    for (const ws of this.socketsFor(pseudonym)) {
      this.closeQuietly(ws, CLOSE.SUSPENDED, "suspended");
    }
    this.broadcastPresence();
  }

  async restore(pseudonym: string): Promise<void> {
    db.removeSuspension(this.sql, pseudonym);
  }

  async deleteMessage(id: string): Promise<{ ok: boolean }> {
    const ok = db.softDeleteMessage(this.sql, id, Date.now());
    if (ok) this.broadcast({ t: "deleted", id });
    return { ok };
  }

  async getMessage(id: string): Promise<Msg | null> {
    return db.findMessage(this.sql, id);
  }

  async stats(): Promise<RoomStats> {
    const { total, since } = db.messageStats(this.sql);
    const online = this.members().length;
    const day = db.utcDay(Date.now());
    return {
      total,
      since,
      peakToday: Math.max(db.readPeak(this.sql, day), online),
      online,
    };
  }

  async countsByPseudonym(): Promise<Record<string, number>> {
    return db.countsByPseudonym(this.sql);
  }

  async suspendedCount(): Promise<number> {
    return db.countSuspensions(this.sql);
  }

  /**
   * Attempt budget for the script front door's bearer check (VRIP-08). It lives
   * here because this object is the only state both Worker isolates share, and
   * the key cannot collide with a pseudonym — the charset has no colon.
   */
  async checkScriptAuth(limit: number): Promise<db.RateVerdict> {
    return db.checkRate(this.sql, "auth:script", limit, Date.now());
  }
}
