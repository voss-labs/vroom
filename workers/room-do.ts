import { DurableObject } from "cloudflare:workers";

import * as policy from "./policy-store";
import {
  broadcast,
  closeQuietly,
  fail,
  members,
  sendTo,
  socketsFor,
} from "./room-broadcast";
import { handleHistory, handleSend, handleWithdraw } from "./room-frames";
import {
  CLOSE,
  PAGE_SIZE,
  isSocketAttachment,
  parseClientFrame,
  type Msg,
  type ServerFrame,
  type SocketAttachment,
  type SystemTone,
} from "./protocol";
import * as db from "./room-sql";

/** Headers the Worker sets after verifying the token. The binding is the boundary. */
export const PSEUDONYM_HEADER = "x-vrooms-pseudonym";
export const ROOM_HEADER = "x-vrooms-room";

export interface RoomStats {
  total: number;
  since: number | null;
  peakToday: number;
  online: number;
  members: string[];
}

export class RoomDurableObject extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      db.ensureSchema(this.sql);
      policy.ensurePolicySchema(this.sql);
    });
  }

  /* ---------------- connection lifecycle ---------------- */

  async fetch(request: Request): Promise<Response> {
    const pseudonym = request.headers.get(PSEUDONYM_HEADER);
    const room = request.headers.get(ROOM_HEADER);
    if (!pseudonym || !room) {
      return new Response("missing pseudonym or room", { status: 400 });
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
    const now = Date.now();
    db.pruneExpiredMessages(this.sql, now);
    const state = db.readRoomState(this.sql);
    const page = db.recentMessages(this.sql, PAGE_SIZE, now);
    const roster = members(this.ctx);
    db.recordPeak(this.sql, db.utcDay(now), roster.length);

    sendTo(server, {
      t: "ready",
      pseudonym,
      room,
      killed: state.killed,
      count: roster.length,
      members: roster,
      messages: page.messages,
      hasMore: page.hasMore,
    });

    // A second tab is the same student, so it is not a new arrival.
    const isFirstSocket = socketsFor(this.ctx, pseudonym).length === 1;
    if (isFirstSocket) {
      broadcast(
        this.ctx,
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
      fail(ws, "bad_frame", "Binary frames are not accepted.");
      return;
    }
    const attachment = ws.deserializeAttachment();
    if (!isSocketAttachment(attachment)) {
      ws.close(CLOSE.BAD_TOKEN, "no attachment");
      return;
    }
    const frame = parseClientFrame(message);
    if (!frame) {
      fail(ws, "bad_frame", "Unrecognised frame.");
      return;
    }

    if (frame.t === "history") {
      handleHistory(
        this.sql,
        this.env,
        ws,
        attachment.p,
        frame.before,
        frame.limit,
      );
      return;
    }

    // `attachment.p` is the authorisation input for every branch below, and it
    // is the only handle in this method. Nothing reads a handle off the frame.
    if (frame.t === "withdraw") {
      handleWithdraw(this.ctx, this.sql, this.env, ws, attachment.p, frame.id);
      return;
    }

    handleSend(
      this.ctx,
      this.sql,
      this.env,
      ws,
      attachment.p,
      frame.body,
      frame.confirmed === true,
    );
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
    if (pseudonym && socketsFor(this.ctx, pseudonym, ws).length === 0) {
      broadcast(
        this.ctx,
        { t: "system", tone: "join", text: `${pseudonym} left` },
        ws,
      );
    }
    this.broadcastPresence(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.broadcastPresence(ws);
  }

  /**
   * Prunes messages past their 48-hour lifetime even when the room is quiet
   * (VRIP-15). Reschedules itself for the oldest remaining message if any stay.
   */
  async alarm(): Promise<void> {
    db.pruneExpiredMessages(this.sql, Date.now());
    const nextExpiry = db.nextExpiryAt(this.sql);
    if (nextExpiry !== null) {
      await this.ctx.storage.setAlarm(nextExpiry);
    }
  }

  /* ---------------- presence ---------------- */

  private broadcastPresence(exclude?: WebSocket): void {
    const roster = members(this.ctx, exclude);
    broadcast(
      this.ctx,
      { t: "presence", count: roster.length, members: roster },
      exclude,
    );
  }

  private system(tone: SystemTone, text: string): void {
    broadcast(this.ctx, { t: "system", tone, text });
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
    broadcast(this.ctx, { t: "room", killed, at });
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
    for (const ws of socketsFor(this.ctx, pseudonym)) {
      closeQuietly(ws, CLOSE.SUSPENDED, "suspended");
    }
    this.broadcastPresence();
  }

  async restore(pseudonym: string): Promise<void> {
    db.removeSuspension(this.sql, pseudonym);
  }

  /**
   * A moderator's deletion, reached only through the console and the script
   * (VRIP-08). It is recorded as the moderator's even when the author withdrew
   * the message first, so the row never reads as though nobody but the author
   * acted on it.
   */
  async deleteMessage(id: string): Promise<{ ok: boolean }> {
    const ok = db.softDeleteMessage(this.sql, id, Date.now(), "moderator");
    if (ok) broadcast(this.ctx, { t: "deleted", id, by: "moderator" });
    return { ok };
  }

  async getMessage(id: string): Promise<Msg | null> {
    const now = Date.now();
    db.pruneExpiredMessages(this.sql, now);
    return db.findMessage(this.sql, id, now);
  }

  async stats(): Promise<RoomStats> {
    const now = Date.now();
    db.pruneExpiredMessages(this.sql, now);
    const { total, since } = db.messageStats(this.sql, now);
    const present = members(this.ctx);
    const online = present.length;
    const day = db.utcDay(now);
    return {
      total,
      since,
      peakToday: Math.max(db.readPeak(this.sql, day), online),
      online,
      members: present,
    };
  }

  async countsByPseudonym(): Promise<Record<string, number>> {
    const now = Date.now();
    db.pruneExpiredMessages(this.sql, now);
    return db.countsByPseudonym(this.sql, now);
  }

  async suspendedCount(): Promise<number> {
    return db.countSuspensions(this.sql);
  }

  /**
   * VRIP-09's flag drain, called by the console loader. `drainFlags` is a pure
   * read and `ackFlags` is the only thing that moves the cursor, so a console
   * that fails between the two sees the same flags again rather than dropping
   * them — and the report insert is keyed on the flag id, so seeing them twice
   * cannot produce two reports.
   */
  async drainFlags(limit = policy.FLAG_DRAIN_LIMIT): Promise<policy.FlagRow[]> {
    return policy.drainFlags(this.sql, limit);
  }

  async ackFlags(throughId: number): Promise<void> {
    policy.ackFlags(this.sql, throughId);
  }

  /** Per-handle policy volume. The count tier produces nothing else. */
  async policyTallies(): Promise<Record<string, Record<string, number>>> {
    return policy.policyTallies(this.sql);
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
