import { and, count, desc, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { db } from "~/db";
import { members, reports } from "~/db/schema";
import type { ReportStatus } from "~/db/schema";

const reportedMember = alias(members, "reported_member");

export interface ReportView {
  id: string;
  messageId: string;
  snapshot: string;
  reason: string | null;
  handle: string | null;
  suspendHandle: string | null;
  reportedMemberId: string | null;
  roomId: string;
  status: string;
  createdAt: Date;
}

const REPORT_COLUMNS = {
  id: reports.id,
  messageId: reports.messageId,
  snapshot: reports.messageSnapshot,
  reason: reports.reason,
  handle: sql<
    string | null
  >`coalesce(${reports.authorHandle}, ${reportedMember.pseudonym})`,
  suspendHandle: sql<
    string | null
  >`case when ${reportedMember.deletedAt} is null then ${reportedMember.pseudonym} else null end`,
  reportedMemberId: reports.reportedMemberId,
  roomId: reports.roomId,
  status: reports.status,
  createdAt: reports.createdAt,
} as const;

export const REPORTS_PAGE_SIZE = 25;

/**
 * The working queue. Open reports come first and resolved ones cannot displace
 * them, because the queue is read under time pressure and a report that is off
 * the end of it is a report nobody acts on. Pagination is real — every row is
 * reachable — and the caller is given the total so the console can say how much
 * it is not showing.
 *
 * Never returns anything that identifies a person. Handles only.
 */
export async function listReports(
  page = 0,
  pageSize = REPORTS_PAGE_SIZE,
): Promise<ReportView[]> {
  return db
    .select(REPORT_COLUMNS)
    .from(reports)
    .leftJoin(reportedMember, eq(reports.reportedMemberId, reportedMember.id))
    .orderBy(
      sql`case when ${reports.status} = 'open' then 0 else 1 end`,
      desc(reports.createdAt),
      desc(reports.id),
    )
    .limit(pageSize)
    .offset(Math.max(0, page) * pageSize);
}

export async function countReports(): Promise<number> {
  const rows = await db.select({ n: count() }).from(reports);
  return rows[0]?.n ?? 0;
}

/**
 * How many reports this member filed since `since`. The report endpoint's rate
 * limit reads it, so the limit survives an isolate restart and is not per-tab.
 */
export async function countRecentReportsBy(
  reporterMemberId: string,
  since: Date,
): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(reports)
    .where(
      and(
        eq(reports.reporterMemberId, reporterMemberId),
        gte(reports.createdAt, since),
      ),
    );
  return rows[0]?.n ?? 0;
}

export async function findReport(id: string): Promise<ReportView | null> {
  const rows = await db
    .select(REPORT_COLUMNS)
    .from(reports)
    .leftJoin(reportedMember, eq(reports.reportedMemberId, reportedMember.id))
    .where(eq(reports.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export interface CreateReportInput {
  roomId: string;
  messageId: string;
  reportedMemberId: string | null;
  authorHandle: string;
  reporterMemberId: string;
  messageSnapshot: string;
  reason?: string | null;
}

/**
 * Returns null when this reporter already filed against this message. The
 * unique index is the control; the caller treats null as "already reported",
 * which is what the student sees anyway.
 */
export async function createReport(
  input: CreateReportInput,
): Promise<{ id: string } | null> {
  const rows = await db
    .insert(reports)
    .values({
      roomId: input.roomId,
      messageId: input.messageId,
      reportedMemberId: input.reportedMemberId,
      authorHandle: input.authorHandle,
      reporterMemberId: input.reporterMemberId,
      messageSnapshot: input.messageSnapshot,
      reason: input.reason ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: reports.id });
  return rows[0] ?? null;
}

export async function setReportStatus(
  id: string,
  status: ReportStatus,
  resolvedBy: string | null,
): Promise<boolean> {
  const rows = await db
    .update(reports)
    .set({ status, resolvedBy, resolvedAt: new Date() })
    .where(and(eq(reports.id, id), eq(reports.status, "open")))
    .returning({ id: reports.id });
  return rows.length === 1;
}
