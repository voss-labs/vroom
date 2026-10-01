import { verifyAppToken } from "~/lib/app-token.server";
import { isValidRoomId } from "~/lib/rooms";

import { CLOSE, PROTOCOL_ID } from "./protocol";
import { PSEUDONYM_HEADER } from "./room-do";

/**
 * The only trust boundary on the socket.
 *
 * The token is read from `sec-websocket-protocol` rather than the query string,
 * because a query string writes a bearer credential into every access log it
 * passes (VRIP-07). It is verified here, in the Worker's fetch handler, before
 * `env.ROOM.get()` is called at all — a bad token never reaches the object.
 *
 * A rejection still completes the 101 and then closes with the contract's code,
 * because a plain HTTP error reaches the browser as an opaque 1006 and the
 * client cannot tell "refetch a token" from "go and sign in".
 */

/** `Sec-WebSocket-Protocol: v-rooms.v1, <token>` */
function readToken(request: Request): string | null {
  const header = request.headers.get("sec-websocket-protocol");
  if (!header) return null;
  const parts = header.split(",").map((p) => p.trim());
  if (parts[0] !== PROTOCOL_ID || parts.length < 2 || !parts[1]) return null;
  return parts[1];
}

/**
 * The browser closes the connection immediately unless the 101 echoes a
 * protocol value, and the failure looks like a network problem.
 */
function upgradeHeaders(): Headers {
  const headers = new Headers();
  headers.set("Sec-WebSocket-Protocol", PROTOCOL_ID);
  return headers;
}

function reject(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];
  // Plain accept, not hibernation: this socket exists for one frame.
  server.accept();
  server.close(code, reason);
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: upgradeHeaders(),
  });
}

export async function handleUpgrade(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade.", { status: 426 });
  }

  const url = new URL(request.url);
  const room = url.searchParams.get("room");
  if (!room || !isValidRoomId(room)) {
    return reject(CLOSE.BAD_TOKEN, "unknown room");
  }

  const token = readToken(request);
  if (!token) return reject(CLOSE.BAD_TOKEN, "missing token");

  const verified = await verifyAppToken(token, room);
  if (!verified.ok) {
    return verified.reason === "expired"
      ? reject(CLOSE.TOKEN_EXPIRED, "token expired")
      : reject(CLOSE.BAD_TOKEN, "bad token");
  }

  const stub = env.ROOM.get(env.ROOM.idFromName(room));
  const forwarded = new Request(request);
  forwarded.headers.set(PSEUDONYM_HEADER, verified.claims.pseudonym);

  const response = await stub.fetch(forwarded);
  if (response.status !== 101 || !response.webSocket) return response;

  return new Response(null, {
    status: 101,
    webSocket: response.webSocket,
    headers: upgradeHeaders(),
  });
}
