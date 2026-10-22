import {
  badCliToken,
  resolveCliSession,
  type ModActor,
} from "~/lib/moderation-actor.server";
import { ModerationError } from "~/lib/require-role.server";
import { tryRoom } from "~/lib/room.server";
import { DEFAULT_ROOM_ID } from "~/lib/rooms";

async function rejectToken(): Promise<never> {
  const attempt = await tryRoom(DEFAULT_ROOM_ID, (room) =>
    room.checkScriptAuth(10),
  );
  if (attempt && !attempt.allowed) {
    throw new ModerationError(
      "rate_limited",
      "Too many attempts. Wait and retry.",
      429,
    );
  }
  throw badCliToken();
}

export async function authenticateScript(request: Request): Promise<ModActor> {
  const header = request.headers.get("authorization");
  if (!header || !/^Bearer [A-Za-z0-9_-]{43}$/.test(header))
    return rejectToken();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(header.slice(7)),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  try {
    return await resolveCliSession(hash, new URL(request.url).origin);
  } catch (error) {
    if (error instanceof ModerationError && error.code === "bad_token")
      return rejectToken();
    throw error;
  }
}
