import { findMemberById } from "~/db/queries/members";
import type { ModActor } from "~/lib/moderation.server";
import { ModerationError, assertModerator } from "~/lib/require-role.server";

export async function requireCurrentModerator(
  actor: ModActor,
): Promise<ModActor> {
  assertModerator(actor.member);
  const member = await findMemberById(actor.member.id);
  if (!member) {
    throw new ModerationError(
      "not_moderator",
      "This account is not a moderator.",
      403,
    );
  }
  assertModerator(member);
  return { member, kind: actor.kind };
}
