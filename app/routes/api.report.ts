import type { ActionFunctionArgs } from "react-router";

import { getSessionUser } from "~/lib/auth.server";
import { ensureMember, findMemberByPseudonym } from "~/db/queries/members";
import { countRecentReportsBy, createReport } from "~/db/queries/reports";
import { isSuspended } from "~/lib/membership.server";
import { isSameOrigin } from "~/lib/origin.server";
import { tryRoom } from "~/lib/room.server";
import { isValidRoomId } from "~/lib/rooms";

/**
 * Filing a report.
 *
 * The wire protocol deliberately has no `report` frame — a report writes to
 * Neon, which the Durable Object cannot reach, and it is not a hot-path
 * operation. It rides an ordinary authenticated POST instead.
 *
 * The message text is read back from the object rather than trusted from the
 * client, so the snapshot in the queue is what was actually said.
 *
 * Everything cheap runs before the Durable Object call: origin, session,
 * suspension and the rate limit. The queue is the only surface a moderator has,
 * so an account that can write to it without a budget can bury a real report,
 * and each unbudgeted call also costs one object RPC and three Neon round trips.
 */

/** A genuine reporter files a handful in a burst; nobody files sixty an hour. */
const REPORT_WINDOW_MS = 10 * 60_000;
const REPORTS_PER_WINDOW = 10;

function fail(code: string, message: string, status: number) {
  return Response.json({ error: { code, message } }, { status });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST")
    return fail("method_not_allowed", "Use POST.", 405);
  if (!isSameOrigin(request))
    return fail("cross_origin", "Cross-origin requests are refused.", 403);

  const user = await getSessionUser(request);
  if (!user) return fail("unauthenticated", "Sign in first.", 401);

  const reporter = await ensureMember(user.id);
  if (isSuspended(reporter))
    return fail("suspended", "This account is suspended.", 403);

  const recent = await countRecentReportsBy(
    reporter.id,
    new Date(Date.now() - REPORT_WINDOW_MS),
  );
  if (recent >= REPORTS_PER_WINDOW) {
    return fail(
      "rate_limited",
      "You have filed too many reports. Try again shortly.",
      429,
    );
  }

  let body: { messageId?: unknown; reason?: unknown; roomId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail("bad_request", "Expected a JSON body.", 400);
  }

  const room = typeof body.roomId === "string" ? body.roomId : null;
  if (!room || !isValidRoomId(room)) {
    return fail("bad_request", "Invalid or missing room ID.", 400);
  }

  const messageId = typeof body.messageId === "string" ? body.messageId : null;
  if (!messageId) return fail("bad_request", "messageId is required.", 400);

  // Wrapped in an object so "the object is unreachable" stays distinguishable
  // from "the object says there is no such message".
  const lookup = await tryRoom(room, async (r) => ({
    message: await r.getMessage(messageId),
  }));
  if (!lookup)
    return fail(
      "room_unreachable",
      "Could not read that message right now.",
      503,
    );
  const message = lookup.message;
  if (!message)
    return fail("message_not_found", "That message no longer exists.", 404);

  const reported = await findMemberByPseudonym(message.who);
  if (!reported)
    return fail("member_not_found", "That handle no longer exists.", 404);
  if (reported.id === reporter.id) {
    return fail("bad_request", "You cannot report your own message.", 400);
  }

  const created = await createReport({
    roomId: room,
    messageId: message.id,
    reportedMemberId: reported.id,
    reporterMemberId: reporter.id,
    messageSnapshot: message.body,
    reason: typeof body.reason === "string" ? body.reason.slice(0, 200) : null,
  });

  // A duplicate is not an error to the student: they reported it, it is reported.
  return Response.json({ data: { ok: true, duplicate: created === null } });
}
