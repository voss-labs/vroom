import { describe, it, expect, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";
import { vi } from "vitest";

import * as schema from "~/db/schema";

/**
 * The report queue is the only surface a moderator has, so what the queue query
 * asks the database for is worth asserting directly.
 *
 * There is still no Neon branch to run against, so the driver here is a stub
 * that records the SQL drizzle emits and answers with fixture rows. That proves
 * the shape of the request — open reports first, a real limit and offset — which
 * is exactly what was missing when a flood could push a genuine report off the
 * end of an unfiltered 200-row cap. It does not prove Postgres executes it as
 * described; only a live database does that.
 */

const seen: Array<{ sql: string; params: unknown[] }> = [];
let answer: unknown[][] = [];

vi.mock("~/db", async () => {
  const db = drizzle(
    async (sql: string, params: unknown[]) => {
      seen.push({ sql, params });
      return { rows: answer };
    },
    { schema },
  );
  return { db, getDb: () => db, schema };
});

const {
  listReports,
  findReport,
  createReport,
  countReports,
  countRecentReportsBy,
  REPORTS_PAGE_SIZE,
} = await import("~/db/queries/reports");

function lastSql(): string {
  return seen[seen.length - 1].sql.toLowerCase();
}

/** pg-proxy hands drizzle positional arrays, in the order of the select. */
function reportRow(id: string, status: string, createdAt: Date): unknown[] {
  return [
    id,
    `msg-${id}`,
    `body of ${id}`,
    null,
    "grumpy-heron",
    "grumpy-heron",
    "m2",
    "campus-live",
    status,
    createdAt,
  ];
}

beforeEach(() => {
  seen.length = 0;
  answer = [];
});

describe("the working queue", () => {
  it("keeps retained evidence visible without a linked author account", async () => {
    answer = [
      [
        "legacy-report",
        "legacy-message",
        "retained evidence",
        null,
        "Local Dev",
        null,
        null,
        "hostel",
        "open",
        new Date("2026-10-20T00:00:00Z"),
      ],
    ];
    const queue = await listReports();
    expect(queue[0]).toMatchObject({
      handle: "Local Dev",
      suspendHandle: null,
      reportedMemberId: null,
    });
    expect(lastSql()).toContain("left join");
    expect(lastSql()).toContain("author_handle");
    expect(lastSql()).toContain("coalesce");
    expect(lastSql()).toContain("deleted_at");
    seen.length = 0;
    expect(await findReport("legacy-report")).toMatchObject({
      handle: "Local Dev",
      suspendHandle: null,
      reportedMemberId: null,
    });
    expect(lastSql()).toContain("left join");
  });

  it("inserts retained author evidence with a null account target", async () => {
    await createReport({
      roomId: "hostel",
      messageId: "legacy-message",
      reportedMemberId: null,
      reporterMemberId: "reporter",
      authorHandle: "Local Dev",
      messageSnapshot: "retained evidence",
    });
    expect(lastSql()).toContain("author_handle");
    expect(seen[0].params).toContain("Local Dev");
    expect(seen[0].params).toContain(null);
  });
  it("asks for open reports first, so a resolved one cannot displace them", async () => {
    await listReports();
    const sql = lastSql();

    expect(sql).toContain("case when");
    expect(sql).toContain("'open'");
    // Ordered before the recency tiebreak, not after it.
    expect(sql.indexOf("case when")).toBeLessThan(
      sql.indexOf("created_at" + '" desc'),
    );
    expect(sql).toContain("desc");
  });

  it("pages rather than truncating: every row is reachable", async () => {
    await listReports(0);
    expect(lastSql()).toContain("limit");
    expect(seen[0].params).toContain(REPORTS_PAGE_SIZE);

    seen.length = 0;
    await listReports(3);
    // Page four starts where page three ended. The old query had no page two.
    expect(lastSql()).toContain("offset");
    expect(seen[0].params).toContain(3 * REPORTS_PAGE_SIZE);
  });

  it("refuses a negative page rather than emitting a negative offset", async () => {
    await listReports(-5);
    // drizzle omits a zero offset entirely, which is the clamp landing.
    expect(lastSql()).not.toContain("offset");
    expect(seen[0].params).not.toContain(-5 * REPORTS_PAGE_SIZE);
  });

  it("surfaces the open report on page one when the queue has been flooded", async () => {
    const genuine = reportRow(
      "genuine",
      "open",
      new Date("2026-08-01T00:00:00Z"),
    );
    // 260 pieces of junk, every one of them newer than the genuine report.
    const junk = Array.from({ length: 260 }, (_, i) =>
      reportRow(`junk-${i}`, "resolved", new Date(Date.now() - i * 1000)),
    );

    // What Postgres returns for this ORDER BY and LIMIT: open first, newest
    // first inside each group, first page only.
    const ordered = [genuine, ...junk];
    answer = ordered.slice(0, REPORTS_PAGE_SIZE);

    const page = await listReports(0);
    expect(page[0].id).toBe("genuine");
    expect(page[0].status).toBe("open");
    expect(page).toHaveLength(REPORTS_PAGE_SIZE);
  });

  it("counts every report, so the console can say what it is not showing", async () => {
    answer = [[261]];
    expect(await countReports()).toBe(261);
    expect(lastSql()).toContain("count");
  });
});

describe("the report endpoint's budget", () => {
  it("counts one member's recent reports, bounded by time", async () => {
    answer = [[7]];
    const since = new Date("2026-08-12T10:00:00Z");
    expect(await countRecentReportsBy("m1", since)).toBe(7);

    const { sql, params } = seen[0];
    expect(sql.toLowerCase()).toContain("reporter_member_id");
    expect(params).toContain("m1");
    // The window is a parameter, so the count cannot silently become all-time.
    expect(
      params.some((p) => p instanceof Date || String(p).includes("2026-08-12")),
    ).toBe(true);
  });
});
