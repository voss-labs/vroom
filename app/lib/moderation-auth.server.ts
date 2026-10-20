import { timingSafeEqual } from "node:crypto";

import { findMemberByPseudonym } from "~/db/queries/members";
import type { ModActor } from "~/lib/moderation.server";
import { ModerationError, assertModerator } from "~/lib/require-role.server";
import { tryRoom } from "~/lib/room.server";
import { DEFAULT_ROOM_ID } from "~/lib/rooms";

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

export async function authenticateScript(request: Request): Promise<ModActor> {
  const expected = process.env.MOD_SCRIPT_TOKEN;
  const header = request.headers.get("authorization");
  const presented = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  let matches = false;
  if (expected && presented) {
    const [a, b] = await Promise.all([digest(presented), digest(expected)]);
    matches = timingSafeEqual(a, b);
  }
  if (!matches) {
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
    throw new ModerationError("bad_token", "Invalid script token.", 401);
  }

  const handle = process.env.MOD_SCRIPT_MEMBER_HANDLE;
  if (!handle) {
    throw new ModerationError(
      "not_moderator",
      "The designated moderator is not configured.",
      500,
    );
  }
  const member = await findMemberByPseudonym(handle);
  if (!member) {
    throw new ModerationError(
      "not_moderator",
      "The designated moderator is unavailable.",
      403,
    );
  }
  assertModerator(member);
  return { member, kind: "script" };
}
