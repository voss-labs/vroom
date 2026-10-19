import type { NeonQueryFunction } from "@neondatabase/serverless";

import { handleCandidate } from "../app/lib/pseudonym";

export class ProvisioningError extends Error {}

type Sql = NeonQueryFunction<false, false>;
interface ModeratorMember {
  id: string;
  pseudonym: string | null;
  is_moderator: boolean;
  deleted_at: string | null;
}

async function readMember(
  sql: Sql,
  userId: string,
): Promise<ModeratorMember | null> {
  const rows = await sql`
    SELECT id, pseudonym, is_moderator, deleted_at
    FROM members WHERE user_id = ${userId} LIMIT 1`;
  return (rows[0] as ModeratorMember | undefined) ?? null;
}

async function claimHandle(sql: Sql, member: ModeratorMember): Promise<string> {
  if (member.pseudonym) return member.pseudonym;
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = handleCandidate(attempt);
    try {
      const claimed = await sql`
        UPDATE members SET pseudonym = ${candidate}
        WHERE id = ${member.id} AND pseudonym IS NULL AND deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM members m2 WHERE m2.pseudonym = ${candidate})
        RETURNING pseudonym`;
      if (typeof claimed[0]?.pseudonym === "string")
        return claimed[0].pseudonym;
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        error.code !== "23505"
      )
        throw error;
    }
    const current =
      await sql`SELECT pseudonym, deleted_at FROM members WHERE id = ${member.id} LIMIT 1`;
    if (!current[0] || current[0].deleted_at !== null)
      throw new ProvisioningError("The member is unavailable.");
    if (typeof current[0].pseudonym === "string") return current[0].pseudonym;
  }
  throw new ProvisioningError(
    "Could not allocate a unique handle. Retry the command.",
  );
}

export async function setModeratorRole(
  sql: Sql,
  userId: string,
  revoke = false,
) {
  const users = await sql`
    SELECT u.id FROM "user" u WHERE u.id = ${userId}
      AND EXISTS (SELECT 1 FROM account a WHERE a.user_id = u.id AND a.provider_id = 'voss')
    LIMIT 1`;
  if (!users[0])
    throw new ProvisioningError(
      "No existing V Auth app user for that ID. Complete operator sign-in first.",
    );
  let member = await readMember(sql, userId);
  if (!member && revoke)
    throw new ProvisioningError(
      "That V Auth user has no moderator member to revoke.",
    );
  if (!member) {
    await sql`INSERT INTO members (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`;
    member = await readMember(sql, userId);
  }
  if (!member || member.deleted_at !== null)
    throw new ProvisioningError("The member is unavailable or deleted.");
  const handle = revoke ? member.pseudonym : await claimHandle(sql, member);
  const updated = await sql`
    UPDATE members SET is_moderator = ${!revoke}
    WHERE id = ${member.id} AND user_id = ${userId} AND deleted_at IS NULL
    RETURNING id`;
  if (!updated[0])
    throw new ProvisioningError(
      "The member changed before its role could be updated.",
    );
  return { memberId: member.id, handle, moderator: !revoke };
}

export async function listModerators(sql: Sql) {
  const rows = await sql`
    SELECT id, user_id, pseudonym, suspended_at FROM members
    WHERE is_moderator = true AND deleted_at IS NULL ORDER BY pseudonym`;
  return rows.map((row) => ({
    memberId: String(row.id),
    userId: String(row.user_id),
    handle: typeof row.pseudonym === "string" ? row.pseudonym : null,
    suspended: row.suspended_at !== null,
  }));
}
