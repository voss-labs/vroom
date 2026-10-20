import { describe, it, expect, beforeEach, vi } from "vitest";
import { drizzle } from "drizzle-orm/pg-proxy";

import * as schema from "~/db/schema";

const seen: string[] = [];
let filteredSelect: unknown[][] = [];
let unfilteredSelect: unknown[][] = [];
let insertResult: unknown[][] = [];

vi.mock("~/db", async () => {
  const db = drizzle(
    async (sql: string) => {
      seen.push(sql);
      const lowered = sql.toLowerCase();
      if (lowered.startsWith("insert")) return { rows: insertResult };
      if (lowered.includes("deleted_at" + '" is null'))
        return { rows: filteredSelect };
      return { rows: unfilteredSelect };
    },
    { schema },
  );
  return { db, getDb: () => db, schema };
});

const {
  ensureMember,
  findAnyMemberByUserId,
  findMemberById,
  findMemberByUserId,
} = await import("~/db/queries/members");
const { isSuspended } = await import("~/lib/membership.server");

const NOW = new Date("2026-08-12T00:00:00Z");

/** Positional row in MEMBER_COLUMNS order. */
function row(
  overrides: {
    moderator?: boolean;
    suspended?: Date | null;
    deleted?: Date | null;
  } = {},
) {
  return [
    "m1",
    "u1",
    "quiet-ibex",
    overrides.moderator ?? true,
    overrides.suspended ?? null,
    null,
    overrides.deleted ?? null,
    NOW,
  ];
}

beforeEach(() => {
  seen.length = 0;
  filteredSelect = [];
  unfilteredSelect = [];
  insertResult = [];
});

describe("no invented moderator", () => {
  it("does not treat a missing user id as Local Dev", async () => {
    filteredSelect = [];
    unfilteredSelect = [];
    expect(await findMemberByUserId("dev-user")).toBeNull();
    expect(await findAnyMemberByUserId("dev-user")).toBeNull();
    expect(await findMemberById("dev-member-id")).toBeNull();
  });
});

describe("ensureMember", () => {
  it("returns a live row without inserting", async () => {
    filteredSelect = [row()];
    const member = await ensureMember("u1");

    expect(member.id).toBe("m1");
    expect(seen.some((sql) => sql.toLowerCase().startsWith("insert"))).toBe(
      false,
    );
  });

  it("inserts on first sight", async () => {
    insertResult = [row()];
    const member = await ensureMember("u1");

    expect(member.id).toBe("m1");
    expect(seen.some((sql) => sql.toLowerCase().startsWith("insert"))).toBe(
      true,
    );
  });

  it("returns the tombstone instead of throwing, so the guards can reject it", async () => {
    // The filtered read cannot see a tombstone, and the insert loses to the
    // user_id unique index. This is the exact sequence that used to 500.
    filteredSelect = [];
    insertResult = [];
    unfilteredSelect = [row({ deleted: NOW })];

    const member = await ensureMember("u1");
    expect(member.deletedAt).toEqual(NOW);

    expect(isSuspended(member)).toBe(true);
  });

  it("still throws when there is genuinely no row, rather than inventing one", async () => {
    filteredSelect = [];
    insertResult = [];
    unfilteredSelect = [];
    await expect(ensureMember("u1")).rejects.toThrow(/no row for user/);
  });

  it("reads the tombstone with an unfiltered query, since a filtered one cannot see it", async () => {
    unfilteredSelect = [row({ deleted: NOW })];
    const found = await findAnyMemberByUserId("u1");

    expect(found?.deletedAt).toEqual(NOW);
    expect(seen[0].toLowerCase()).not.toContain("deleted_at" + '" is null');
  });
});

describe("a suspended moderator read from the database", () => {
  it("is refused, which a hand-built record could never have proven", async () => {
    filteredSelect = [row({ moderator: true, suspended: NOW })];
    const member = await ensureMember("u1");

    expect(member.isModerator).toBe(true);
    expect(member.suspendedAt).toEqual(NOW);
    expect(isSuspended(member)).toBe(true);
  });
});
