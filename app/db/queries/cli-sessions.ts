import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { db } from "~/db";
import { cliSessions } from "~/db/schema";

export async function findLiveCliSession(
  tokenHash: string,
  origin: string,
  sessionId?: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: cliSessions.id })
    .from(cliSessions)
    .where(
      and(
        eq(cliSessions.tokenHash, tokenHash),
        eq(cliSessions.origin, origin),
        sessionId === undefined ? undefined : eq(cliSessions.id, sessionId),
        isNull(cliSessions.revokedAt),
        gt(cliSessions.expiresAt, sql`statement_timestamp()`),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
