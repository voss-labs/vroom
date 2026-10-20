import { redirect } from "react-router";

import { findMemberById, type MemberRecord } from "~/db/queries/members";
import { readDeviceSession } from "~/lib/device-session.server";

export interface Actor {
  kind: "device";
  member: MemberRecord;
}

export class ModerationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ModerationError";
  }
}

export async function resolveActor(request: Request): Promise<Actor | null> {
  const memberId = await readDeviceSession(request);
  if (!memberId) return null;
  const member = await findMemberById(memberId);
  if (!member || member.userId !== null) return null;
  return { kind: "device", member };
}

export async function requireSession(request: Request): Promise<Actor> {
  const actor = await resolveActor(request);
  if (!actor)
    throw redirect("/", { headers: { "Cache-Control": "private, no-store" } });
  return actor;
}
