import { beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";
import * as schema from "~/db/schema";

const seen: Array<{ sql: string; params: unknown[] }> = [];
let rows: unknown[][] = [];

vi.mock("~/db", async () => ({
  db: drizzle(
    async (sql: string, params: unknown[]) => {
      seen.push({ sql, params });
      return { rows };
    },
    { schema },
  ),
}));

const { listAccounts, countAccounts } = await import("~/db/queries/members");
const { listAudit, countAudit } = await import("~/db/queries/audit");

beforeEach(() => {
  seen.length = 0;
  rows = [];
});

describe("moderation account pagination", () => {
  it("pages the handle-ordered live account set without selecting identity credentials", async () => {
    await listAccounts(2, 25);
    const { sql, params } = seen[0];
    expect(sql.toLowerCase()).toContain('"pseudonym" is not null');
    expect(sql.toLowerCase()).toContain('"deleted_at" is null');
    expect(sql.toLowerCase()).toContain('order by "members"."pseudonym"');
    expect(sql.toLowerCase()).toContain("limit");
    expect(sql.toLowerCase()).toContain("offset");
    expect(params).toEqual([25, 50]);
    expect(sql).not.toContain("key_hash");
    expect(sql).not.toContain("user_id");
    expect(sql).not.toContain("email");
  });

  it("counts the same live handle-bearing accounts that can be paged", async () => {
    rows = [[29]];
    expect(await countAccounts()).toBe(29);
    expect(seen[0].sql.toLowerCase()).toContain('"pseudonym" is not null');
    expect(seen[0].sql.toLowerCase()).toContain('"deleted_at" is null');
  });

  it("projects suspension state from real account query rows", async () => {
    rows = [["internal", "grumpy-heron", "2026-01-01T00:00:00Z", "abuse"]];
    expect(await listAccounts()).toEqual([
      {
        id: "internal",
        handle: "grumpy-heron",
        suspended: true,
        suspendedReason: "abuse",
      },
    ]);
  });
});

describe("moderation audit pagination", () => {
  it("pages all audit rows in deterministic newest-first order", async () => {
    await listAudit(3, 25);
    const { sql, params } = seen[0];
    expect(sql.toLowerCase()).toContain('"created_at" desc');
    expect(sql.toLowerCase()).toContain('"id" desc');
    expect(sql.toLowerCase()).toContain("left join");
    expect(params).toEqual([25, 75]);
    expect(sql).not.toContain("user_id");
    expect(sql).not.toContain("key_hash");
    expect(sql).not.toContain("email");
  });

  it("counts audit history independently from the requested page", async () => {
    rows = [[103]];
    expect(await countAudit()).toBe(103);
    expect(seen[0].sql.toLowerCase()).toContain("count");
    expect(seen[0].sql.toLowerCase()).not.toContain("limit");
  });

  it("allows an empty page beyond the retained history", async () => {
    expect(await listAudit(100, 25)).toEqual([]);
    expect(seen[0].params).toEqual([25, 2500]);
  });
});
