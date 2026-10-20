import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NeonQueryFunction } from "@neondatabase/serverless";

vi.mock("../../app/lib/pseudonym", () => ({
  handleCandidate: (attempt: number) => `quiet-ibex${attempt}`,
}));
import { listModerators, setModeratorRole } from "../../scripts/promote-core";

const sql = vi.fn();
const database = sql as unknown as NeonQueryFunction<false, false>;
const existing = {
  id: "member-1",
  pseudonym: "quiet-ibex",
  is_moderator: false,
  deleted_at: null,
};

beforeEach(() => vi.resetAllMocks());

describe("explicit V Auth moderator provisioning", () => {
  it("validates a real linked app user before creating a member, claims a handle and grants", async () => {
    sql
      .mockResolvedValueOnce([{ id: "user-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...existing, pseudonym: null }])
      .mockResolvedValueOnce([{ pseudonym: "quiet-ibex0" }])
      .mockResolvedValueOnce([{ id: "member-1" }]);
    expect(await setModeratorRole(database, "user-1")).toEqual({
      memberId: "member-1",
      handle: "quiet-ibex0",
      moderator: true,
    });
    const queries = sql.mock.calls.map(([parts]) => parts.join("?")).join("\n");
    expect(queries).toContain("a.provider_id = 'voss'");
    expect(queries).toContain("ON CONFLICT (user_id) DO NOTHING");
    expect(queries).not.toContain("email");
    expect(queries).not.toContain('INSERT INTO "user"');
    expect(sql.mock.calls.at(-1)?.[1]).toBe(true);
  });

  it("preserves an existing moderator handle and supports revocation", async () => {
    sql
      .mockResolvedValueOnce([{ id: "user-1" }])
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([{ id: "member-1" }]);
    expect(await setModeratorRole(database, "user-1", true)).toEqual({
      memberId: "member-1",
      handle: "quiet-ibex",
      moderator: false,
    });
    expect(sql).toHaveBeenCalledTimes(3);
  });

  it("refuses an unknown or unlinked user before inserting any member", async () => {
    sql.mockResolvedValueOnce([]);
    await expect(setModeratorRole(database, "missing")).rejects.toThrow(
      "No existing V Auth app user",
    );
    expect(sql).toHaveBeenCalledTimes(1);
  });

  it("refuses a tombstone instead of resurrecting or linking it", async () => {
    sql
      .mockResolvedValueOnce([{ id: "user-1" }])
      .mockResolvedValueOnce([{ ...existing, deleted_at: "2026-10-01" }]);
    await expect(setModeratorRole(database, "user-1")).rejects.toThrow(
      "deleted",
    );
    expect(sql).toHaveBeenCalledTimes(2);
  });

  it("recovers from concurrent member creation and handle uniqueness conflict", async () => {
    sql
      .mockResolvedValueOnce([{ id: "user-1" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...existing, pseudonym: null }])
      .mockRejectedValueOnce({ code: "23505" })
      .mockResolvedValueOnce([{ pseudonym: "winner-handle", deleted_at: null }])
      .mockResolvedValueOnce([{ id: "member-1" }]);
    expect(await setModeratorRole(database, "user-1")).toMatchObject({
      handle: "winner-handle",
      moderator: true,
    });
  });

  it("does not grant a role after an unrelated SQL failure", async () => {
    sql
      .mockResolvedValueOnce([{ id: "user-1" }])
      .mockResolvedValueOnce([{ ...existing, pseudonym: null }])
      .mockRejectedValueOnce({ code: "08006" });
    await expect(setModeratorRole(database, "user-1")).rejects.toMatchObject({
      code: "08006",
    });
    expect(sql).toHaveBeenCalledTimes(3);
  });

  it("reports a role update lost to deletion", async () => {
    sql
      .mockResolvedValueOnce([{ id: "user-1" }])
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([]);
    await expect(setModeratorRole(database, "user-1")).rejects.toThrow(
      "changed before",
    );
  });

  it("lists only IDs, handles and state", async () => {
    sql.mockResolvedValueOnce([
      {
        id: "member-1",
        user_id: "user-1",
        pseudonym: "quiet-ibex",
        suspended_at: null,
      },
    ]);
    expect(await listModerators(database)).toEqual([
      {
        memberId: "member-1",
        userId: "user-1",
        handle: "quiet-ibex",
        suspended: false,
      },
    ]);
    expect(sql.mock.calls[0][0].join("?")).not.toContain("email");
  });
});
