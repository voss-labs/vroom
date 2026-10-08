import { and, eq, isNull, isNotNull, sql } from "drizzle-orm";

import { db } from "~/db";
import { members, user } from "~/db/schema";

/**
 * Explicit column lists everywhere. A bare `select()` on `members` is fine
 * today because the table has no email — but the habit is what keeps it true.
 */
const MEMBER_COLUMNS = {
  id: members.id,
  userId: members.userId,
  pseudonym: members.pseudonym,
  isModerator: members.isModerator,
  suspendedAt: members.suspendedAt,
  suspendedReason: members.suspendedReason,
  deletedAt: members.deletedAt,
  createdAt: members.createdAt,
} as const;

export type MemberRecord = {
  id: string;
  /** Set for a moderator's V Auth account, null for a student device key. */
  userId: string | null;
  pseudonym: string | null;
  isModerator: boolean;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  deletedAt: Date | null;
  createdAt: Date;
};

export async function findMemberByUserId(
  userId: string,
): Promise<MemberRecord | null> {
  if (userId === "dev-user") {
    return {
      id: "dev-member-id",
      userId: "dev-user",
      pseudonym: "Local Dev",
      isModerator: true, // Needs to be true for mod console
      suspendedAt: null,
      suspendedReason: null,
      deletedAt: null,
      createdAt: new Date(),
    };
  }

  const rows = await db
    .select(MEMBER_COLUMNS)
    .from(members)
    .where(and(eq(members.userId, userId), isNull(members.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findMemberById(id: string): Promise<MemberRecord | null> {
  if (id === "dev-member-id") {
    return {
      id: "dev-member-id",
      userId: "dev-user",
      pseudonym: "Local Dev",
      isModerator: true, // Needs to be true for mod console
      suspendedAt: null,
      suspendedReason: null,
      deletedAt: null,
      createdAt: new Date(),
    };
  }

  const rows = await db
    .select(MEMBER_COLUMNS)
    .from(members)
    .where(eq(members.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findMemberByPseudonym(
  pseudonym: string,
): Promise<MemberRecord | null> {
  const rows = await db
    .select(MEMBER_COLUMNS)
    .from(members)
    .where(eq(members.pseudonym, pseudonym))
    .limit(1);
  return rows[0] ?? null;
}

/** Includes tombstones, so a soft-deleted account stays visible to the guards. */
export async function findAnyMemberByUserId(
  userId: string,
): Promise<MemberRecord | null> {
  if (userId === "dev-user") {
    return {
      id: "dev-member-id",
      userId: "dev-user",
      pseudonym: "Local Dev",
      isModerator: true, // Needs to be true for mod console
      suspendedAt: null,
      suspendedReason: null,
      deletedAt: null,
      createdAt: new Date(),
    };
  }

  const rows = await db
    .select(MEMBER_COLUMNS)
    .from(members)
    .where(eq(members.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

/** Idempotent: a second call for the same user returns the existing row. */
export async function ensureMember(userId: string): Promise<MemberRecord> {
  const existing = await findMemberByUserId(userId);
  if (existing) return existing;

  // TODO: Re-enable auth
  if (userId === "dev-user") {
    await db
      .insert(user)
      .values({
        id: "dev-user",
        name: "Local Dev",
        email: "dev@vit.edu.in",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoNothing();
  }

  const rows = await db
    .insert(members)
    .values({ userId })
    .onConflictDoNothing({ target: members.userId })
    .returning(MEMBER_COLUMNS);

  if (rows[0]) return rows[0];

  // Either the insert lost a race, or a tombstone holds the user_id unique
  // index — the read above filters deletedAt, so it cannot see one. Returning
  // the tombstone is what keeps soft delete usable: the guards reject it
  // through isSuspended(), where throwing here 500s every request that account
  // makes, permanently, and makes deletedAt a column nothing can set.
  const found = await findAnyMemberByUserId(userId);
  if (!found) throw new Error(`ensureMember: no row for user ${userId}`);
  return found;
}

/** Includes tombstones, for the same reason as findAnyMemberByUserId. */
export async function findAnyMemberByKeyHash(
  keyHash: string,
): Promise<MemberRecord | null> {
  const rows = await db
    .select(MEMBER_COLUMNS)
    .from(members)
    .where(eq(members.keyHash, keyHash))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The student counterpart of ensureMember (VRIP-13). Idempotent per key, and a
 * tombstone is returned rather than thrown so the guards can refuse it.
 */
export async function ensureMemberByKey(
  keyHash: string,
): Promise<MemberRecord> {
  const existing = await findAnyMemberByKeyHash(keyHash);
  if (existing) return existing;

  const rows = await db
    .insert(members)
    .values({ keyHash })
    .onConflictDoNothing({ target: members.keyHash })
    .returning(MEMBER_COLUMNS);
  if (rows[0]) return rows[0];

  const found = await findAnyMemberByKeyHash(keyHash);
  if (!found) throw new Error("ensureMemberByKey: no row for this key");
  return found;
}

/**
 * Race-safe claim, ported from voss-ask's ClaimUsername.
 *
 * The WHERE clause embeds both "no pseudonym yet" and "no other row holds this
 * one", so two concurrent claimers cannot both win. A collision is a successful
 * call returning false — not an error. An error means the database was
 * unreachable, which the caller reports differently.
 */
export async function claimPseudonym(
  memberId: string,
  candidate: string,
): Promise<boolean> {
  const rows = await db
    .update(members)
    .set({ pseudonym: candidate })
    .where(
      and(
        eq(members.id, memberId),
        isNull(members.pseudonym),
        sql`NOT EXISTS (SELECT 1 FROM ${members} m2 WHERE m2.pseudonym = ${candidate})`,
      ),
    )
    .returning({ id: members.id });
  return rows.length === 1;
}

export async function setSuspended(
  memberId: string,
  suspended: boolean,
  reason?: string | null,
): Promise<MemberRecord | null> {
  const rows = await db
    .update(members)
    .set({
      suspendedAt: suspended ? new Date() : null,
      suspendedReason: suspended ? (reason ?? null) : null,
    })
    .where(eq(members.id, memberId))
    .returning(MEMBER_COLUMNS);
  return rows[0] ?? null;
}

export async function countSuspended(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(members)
    .where(and(isNotNull(members.suspendedAt), isNull(members.deletedAt)));
  return rows[0]?.n ?? 0;
}

/** The console's accounts table. Handles only — there is no email here by design. */
export async function listAccounts(): Promise<
  Array<{
    id: string;
    handle: string;
    suspended: boolean;
    suspendedReason: string | null;
  }>
> {
  const rows = await db
    .select({
      id: members.id,
      pseudonym: members.pseudonym,
      suspendedAt: members.suspendedAt,
      suspendedReason: members.suspendedReason,
    })
    .from(members)
    .where(and(isNotNull(members.pseudonym), isNull(members.deletedAt)))
    .orderBy(members.pseudonym);

  return rows.map((r) => ({
    id: r.id,
    handle: r.pseudonym!,
    suspended: r.suspendedAt !== null,
    suspendedReason: r.suspendedReason,
  }));
}
