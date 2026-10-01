import {
  CLOSE,
  PAGE_SIZE,
  PROTOCOL_ID,
  type Msg,
  type ServerFrame,
  type SystemTone,
} from "../../workers/protocol";

/**
 * The browser half of the socket: connect, reconnect with backoff, close-code
 * handling, backfill, and the local block list.
 *
 * The token is fetched fresh for every connect attempt, because it authorises
 * opening a socket and nothing more. A 4003 is terminal — the client must not
 * reconnect (VRIP-07).
 */

export type ConnectionState =
  "connecting" | "open" | "reconnecting" | "closed" | "signed-out";

export interface LogEntry {
  kind: "msg" | "system";
  key: string;
  msg?: Msg;
  tone?: SystemTone;
  text?: string;
}

export interface RoomHandlers {
  onState(state: ConnectionState): void;
  onReady(data: {
    pseudonym: string;
    killed: boolean;
    messages: Msg[];
    hasMore: boolean;
  }): void;
  onMessage(msg: Msg): void;
  onDeleted(id: string): void;
  onPresence(count: number, members: string[]): void;
  onRoom(killed: boolean): void;
  onSystem(tone: SystemTone, text: string): void;
  onHistory(messages: Msg[], hasMore: boolean): void;
  onError(code: string, message: string, retryAfter?: number): void;
}

const BLOCK_KEY = "v-rooms.blocked";
const MAX_BACKOFF_MS = 30_000;

export function loadBlocked(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(BLOCK_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function saveBlocked(blocked: Set<string>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(BLOCK_KEY, JSON.stringify([...blocked]));
  } catch {
    // A full or disabled store is not worth breaking the room over.
  }
}

interface TokenResponse {
  data?: { token: string; wsUrl: string };
}

export class RoomConnection {
  private socket: WebSocket | null = null;
  private attempts = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly roomId: string,
    private readonly handlers: RoomHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close(CLOSE.NORMAL, "leaving");
    this.socket = null;
  }

  send(body: string): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ t: "send", body }));
    return true;
  }

  requestHistory(before: number, limit = PAGE_SIZE): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ t: "history", before, limit }));
    return true;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.handlers.onState(this.attempts === 0 ? "connecting" : "reconnecting");

    let token: string;
    let wsUrl: string;
    try {
      const response = await fetch("/api/socket-token", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ roomId: this.roomId }),
      });
      if (response.status === 401) return this.terminal("signed-out");
      if (response.status === 403) return this.terminal("closed");
      if (!response.ok) throw new Error(`token ${response.status}`);
      const body = (await response.json()) as TokenResponse;
      if (!body.data) throw new Error("token payload");
      token = body.data.token;
      wsUrl = body.data.wsUrl;
    } catch {
      return this.retry();
    }

    // Second subprotocol value carries the token, so it never lands in a URL.
    const socket = new WebSocket(wsUrl, [PROTOCOL_ID, token]);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.handlers.onState("open");
    };

    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data) as ServerFrame;
      } catch {
        return;
      }
      this.dispatch(frame);
    };

    socket.onclose = (event) => {
      this.socket = null;
      if (this.stopped) return;
      if (event.code === CLOSE.SUSPENDED) return this.terminal("closed");
      if (event.code === CLOSE.BAD_TOKEN) return this.terminal("signed-out");
      // 4001 is expected: refetch a token and reconnect immediately.
      if (event.code === CLOSE.TOKEN_EXPIRED) {
        this.attempts = 0;
        return this.retry(0);
      }
      this.retry();
    };

    socket.onerror = () => {
      // onclose always follows; retrying here would double-schedule.
    };
  }

  private dispatch(frame: ServerFrame): void {
    switch (frame.t) {
      case "ready":
        this.handlers.onReady({
          pseudonym: frame.pseudonym,
          killed: frame.killed,
          messages: frame.messages,
          hasMore: frame.hasMore,
        });
        this.handlers.onPresence(frame.count, frame.members);
        return;
      case "message":
        return this.handlers.onMessage(frame.m);
      case "deleted":
        return this.handlers.onDeleted(frame.id);
      case "presence":
        return this.handlers.onPresence(frame.count, frame.members);
      case "room":
        return this.handlers.onRoom(frame.killed);
      case "system":
        return this.handlers.onSystem(frame.tone, frame.text);
      case "history":
        return this.handlers.onHistory(frame.messages, frame.hasMore);
      case "error":
        return this.handlers.onError(
          frame.code,
          frame.message,
          frame.retryAfter,
        );
    }
  }

  private terminal(state: ConnectionState): void {
    this.stopped = true;
    this.handlers.onState(state);
  }

  private retry(delayMs?: number): void {
    if (this.stopped) return;
    this.attempts += 1;
    const backoff =
      delayMs ??
      Math.min(MAX_BACKOFF_MS, 500 * 2 ** (this.attempts - 1)) +
        Math.random() * 400;
    this.handlers.onState("reconnecting");
    this.timer = setTimeout(() => void this.connect(), backoff);
  }
}

export function socketUrl(origin: string, room: string): string {
  const url = new URL("/ws", origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("room", room);
  return url.toString();
}
