import type { ActionFunctionArgs } from "react-router";

import { resolveActor } from "~/lib/require-role.server";
import {
  ensurePseudonym,
  isSuspended,
  PseudonymExhausted,
} from "~/lib/membership.server";
import { mintAppToken } from "~/lib/app-token.server";
import { isSameOrigin } from "~/lib/origin.server";
import { socketUrl } from "~/lib/room-client";
import { isRoomId } from "~/lib/rooms";

/**
 * Mints the app token for one room. Same-origin and session required,
 * pseudonym assigned on first call, and a suspended member is refused so they
 * cannot even obtain a token (VRIP-07).
 */

function fail(code: string, message: string, status: number) {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST")
    return fail("method_not_allowed", "Use POST.", 405);
  if (!isSameOrigin(request))
    return fail("cross_origin", "Cross-origin requests are refused.", 403);

  let body: { roomId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail("bad_request", "Expected a JSON body.", 400);
  }
  const room = body.roomId;
  if (!isRoomId(room)) return fail("unknown_room", "No such room.", 400);

  const actor = await resolveActor(request);
  if (!actor) return fail("unauthenticated", "Sign in to join the room.", 401);

  const member = actor.member;
  if (isSuspended(member)) {
    return fail("suspended", "This account is suspended.", 403);
  }

  let withHandle;
  try {
    withHandle = await ensurePseudonym(member);
  } catch (error) {
    if (error instanceof PseudonymExhausted) {
      console.error("[socket-token] pseudonym allocation exhausted", error);
      return fail(
        "pseudonym_unavailable",
        "Could not assign a handle. Try again.",
        503,
      );
    }
    throw error;
  }

  const pseudonym = withHandle.pseudonym;
  if (!pseudonym)
    return fail("pseudonym_unavailable", "Could not assign a handle.", 503);

  const expiresIn = Number(process.env.APP_JWT_TTL_SECONDS) || 900;
  const token = await mintAppToken({ pseudonym, room }, expiresIn);

  return Response.json(
    {
      data: {
        token,
        expiresIn,
        pseudonym,
        wsUrl: socketUrl(new URL(request.url).origin, room),
      },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
