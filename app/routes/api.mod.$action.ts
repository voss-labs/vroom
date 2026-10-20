import type { ActionFunctionArgs } from "react-router";

import { authenticateScript } from "~/lib/moderation-auth.server";
import type { ModError } from "~/lib/moderation-contract";
import { isModReadAction, readModeration } from "~/lib/moderation-read.server";
import {
  isModIntent,
  PartialModerationError,
  performModeration,
  type ModFields,
} from "~/lib/moderation.server";
import { isBrowserCrossOrigin } from "~/lib/origin.server";
import { ModerationError } from "~/lib/require-role.server";

const HEADERS = { "cache-control": "no-store" };

function fail(
  code: string,
  message: string,
  status: number,
  detail?: Partial<ModError>,
) {
  return Response.json(
    { error: { code, message, ...detail } },
    { status, headers: HEADERS },
  );
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ModerationError("bad_request", "A JSON object is required.", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ModerationError("bad_request", "A JSON object is required.", 400);
  }
  return body as Record<string, unknown>;
}

export function loader() {
  return fail("method_not_allowed", "Use POST.", 405);
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST")
    return fail("method_not_allowed", "Use POST.", 405);
  if (isBrowserCrossOrigin(request)) {
    return fail("cross_origin", "Cross-origin requests are refused.", 403);
  }

  try {
    const actor = await authenticateScript(request);
    const intent = params.action;
    if (!isModIntent(intent) && !isModReadAction(intent)) {
      return fail("bad_request", "Unknown action.", 400);
    }
    const body = await readBody(request);
    if (isModReadAction(intent)) {
      const result = await readModeration(actor, intent, body);
      return Response.json({ data: result }, { headers: HEADERS });
    }

    if (intent === "set_room_state" && typeof body.killed !== "boolean") {
      return fail("bad_request", "A boolean room state is required.", 400);
    }
    if (body.reason !== undefined && typeof body.reason !== "string") {
      return fail("bad_request", "Reason must be text.", 400);
    }

    if (
      (intent === "suspend" || intent === "restore") &&
      (typeof body.handle !== "string" || !body.handle)
    ) {
      return fail("bad_request", "A handle is required.", 400);
    }
    const fields: ModFields = {
      reportId: typeof body.reportId === "string" ? body.reportId : null,
      handle: typeof body.handle === "string" ? body.handle : undefined,
      reason: typeof body.reason === "string" ? body.reason : null,
      killed: body.killed === true,
    };
    const result = await performModeration(actor, intent, fields);
    return Response.json({ data: result }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof PartialModerationError) {
      return fail(error.code, error.message, error.status, {
        partial: true,
        rooms: error.rooms,
      });
    }
    if (error instanceof ModerationError) {
      return fail(error.code, error.message, error.status);
    }
    console.error("[api.mod] action failed");
    return fail("internal_error", "The action failed.", 500);
  }
}
