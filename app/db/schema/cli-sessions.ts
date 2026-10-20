import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const cliSessions = pgTable(
  "cli_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    origin: text("origin").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`statement_timestamp()`),
    expiresAt: timestamp("expires_at", { withTimezone: true })
      .notNull()
      .default(sql`statement_timestamp() + interval '15 minutes'`),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("cli_sessions_expires_at_idx").on(t.expiresAt),
    check("cli_sessions_token_hash", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
    check("cli_sessions_origin", sql`${t.origin} ~ '[^[:space:]]'`),
    check(
      "cli_sessions_lifetime",
      sql`${t.expiresAt} > ${t.createdAt} AND ${t.expiresAt} <= ${t.createdAt} + interval '15 minutes'`,
    ),
    check(
      "cli_sessions_revocation",
      sql`${t.revokedAt} IS NULL OR ${t.revokedAt} >= ${t.createdAt}`,
    ),
  ],
);
