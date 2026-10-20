import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  unique,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";

import { members } from "./members";

/**
 * A student's report of a message.
 *
 * `messageSnapshot` copies the message text into Neon, which is the one place
 * the VRIP-03 storage split bends. It is deliberate: the console has to show the
 * reported text after the message is deleted, the reveal dialog quotes it, and
 * the queue must render when the Durable Object is asleep. It is report data —
 * a frozen quote, not a second copy of the log.
 */
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: text("room_id").notNull().default("campus-live"),
    // The DO SQLite message id. No FK: it lives in a different store.
    messageId: text("message_id").notNull(),
    reportedMemberId: uuid("reported_member_id").references(() => members.id, {
      onDelete: "set null",
    }),
    authorHandle: text("author_handle"),
    // Null for an auto-flag. See the note above.
    reporterMemberId: uuid("reporter_member_id").references(() => members.id, {
      onDelete: "cascade",
    }),
    messageSnapshot: text("message_snapshot").notNull(),
    reason: text("reason"),
    // open | resolved | dismissed
    status: text("status").notNull().default("open"),
    resolvedBy: uuid("resolved_by").references(() => members.id, {
      onDelete: "set null",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One student cannot inflate the queue by reporting the same message twice.
    unique("reports_message_reporter_uniq").on(t.messageId, t.reporterMemberId),
    // Postgres treats NULLs as distinct, so the constraint above cannot dedupe
    // auto-flags. This one can: the message id encodes the flag id.
    uniqueIndex("reports_auto_flag_uniq")
      .on(t.roomId, t.messageId)
      .where(sql`reporter_member_id is null`),
    index("reports_status_created_idx").on(t.status, t.createdAt),
    check(
      "reports_retained_author",
      sql`${t.reportedMemberId} is not null or coalesce(${t.authorHandle} ~ '[^[:space:]]', false)`,
    ),
  ],
);

export type Report = typeof reports.$inferSelect;
export const REPORT_STATUS = ["open", "resolved", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUS)[number];
