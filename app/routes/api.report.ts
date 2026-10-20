import type { ActionFunctionArgs } from "react-router";

import { createReport, countRecentReportsBy } from "~/db/queries/reports";
import { findMemberByPseudonym } from "~/db/queries/members";
import { isSuspended } from "~/lib/membership.server";
import { isSameOrigin } from "~/lib/origin.server";
import { resolveActor } from "~/lib/require-role.server";
import { REPORT_FAILURES } from "~/lib/report-errors";
import { tryRoom } from "~/lib/room.server";
import { isRoomId } from "~/lib/rooms";

const REPORTS_PER_WINDOW = 10;
const REPORT_WINDOW_MS = 10 * 60 * 1000;
const HEADERS = { "Cache-Control": "private, no-store" };

function fail(failure: keyof typeof REPORT_FAILURES) {
  const { code, message, status } = REPORT_FAILURES[failure];
  return Response.json(
    { error: { code, message } },
    { status, headers: HEADERS },
  );
}

async function submit(request: Request) {
  const actor = await resolveActor(request);
  if (!actor) return fail("session");
  const reporter = actor.member;
  if (isSuspended(reporter)) return fail("suspended");

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return fail("body");
  const fields = body as Record<string, unknown>;
  const room = fields.roomId;
  if (!isRoomId(room)) return fail("room");
  const messageId =
    typeof fields.messageId === "string" ? fields.messageId : null;
  if (!messageId) return fail("message");

  const recent = await countRecentReportsBy(
    reporter.id,
    new Date(Date.now() - REPORT_WINDOW_MS),
  );
  if (recent >= REPORTS_PER_WINDOW) return fail("budget");
  const lookup = await tryRoom(room, async (stub) => ({
    message: await stub.getMessage(messageId),
  }));
  if (!lookup) return fail("outage");
  const message = lookup.message;
  if (!message) return fail("expired");
  if (message.who === reporter.pseudonym) return fail("self");
  const reported = await findMemberByPseudonym(message.who);
  if (reported?.id === reporter.id) return fail("self");
  const created = await createReport({
    roomId: room,
    messageId: message.id,
    reportedMemberId:
      reported && reported.deletedAt === null ? reported.id : null,
    reporterMemberId: reporter.id,
    authorHandle: message.who,
    messageSnapshot: message.body,
    reason:
      typeof fields.reason === "string" ? fields.reason.slice(0, 200) : null,
  });
  return Response.json(
    { data: { ok: true, duplicate: created === null } },
    { headers: HEADERS },
  );
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return fail("method");
  if (!isSameOrigin(request)) return fail("origin");
  try {
    return await submit(request);
  } catch {
    console.error("[report] request failed");
    return fail("unavailable");
  }
}
