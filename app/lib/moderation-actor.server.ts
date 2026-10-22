import { findLiveCliSession } from "~/db/queries/cli-sessions";
import { ModerationError } from "~/lib/require-role.server";

export interface ModActor {
  kind: "script";
  sessionId: string;
  tokenHash: string;
  origin: string;
}

export const CLI_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function badCliToken(): ModerationError {
  return new ModerationError("bad_token", "Invalid CLI session.", 401);
}

export async function resolveCliSession(
  tokenHash: string,
  origin: string,
  sessionId?: string,
): Promise<ModActor> {
  let session;
  try {
    session = await findLiveCliSession(tokenHash, origin, sessionId);
  } catch {
    throw new ModerationError(
      "moderation_auth_unavailable",
      "Moderation authentication is unavailable.",
      503,
    );
  }
  if (!session || !CLI_SESSION_ID.test(session.id)) throw badCliToken();
  return { kind: "script", sessionId: session.id, tokenHash, origin };
}

export async function requireCurrentModerator(
  actor: ModActor,
): Promise<ModActor> {
  if (
    !actor ||
    actor.kind !== "script" ||
    typeof actor.sessionId !== "string" ||
    !CLI_SESSION_ID.test(actor.sessionId) ||
    typeof actor.tokenHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(actor.tokenHash) ||
    typeof actor.origin !== "string"
  )
    throw badCliToken();
  try {
    const url = new URL(actor.origin);
    if (url.origin !== actor.origin || url.origin === "null")
      throw badCliToken();
  } catch {
    throw badCliToken();
  }
  return resolveCliSession(actor.tokenHash, actor.origin, actor.sessionId);
}
