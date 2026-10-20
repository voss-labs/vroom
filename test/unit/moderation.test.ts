import { describe, it, expect, vi, beforeEach } from "vitest";

import type { MemberRecord } from "~/db/queries/members";

const findMemberById = vi.fn();
const setSuspended = vi.fn();
const findReport = vi.fn();
const setReportStatus = vi.fn();
const writeAudit = vi.fn();
const getRoom = vi.fn();

vi.mock("~/db/queries/members", () => ({
  findMemberById: (...a: unknown[]) => findMemberById(...a),
  setSuspended: (...a: unknown[]) => setSuspended(...a),
  claimPseudonym: vi.fn(),
}));
vi.mock("~/db/queries/reports", () => ({
  findReport: (...a: unknown[]) => findReport(...a),
  setReportStatus: (...a: unknown[]) => setReportStatus(...a),
}));
vi.mock("~/db/queries/audit", () => ({
  writeAudit: (...a: unknown[]) => writeAudit(...a),
}));
vi.mock("~/lib/room.server", () => ({
  getRoom: (id: string) => getRoom(id),
  RoomUnreachable: class RoomUnreachable extends Error {},
}));

const { performModeration, MOD_INTENTS, isModIntent } =
  await import("~/lib/moderation.server");
const { ModerationError } = await import("~/lib/require-role.server");
const { ROOM_IDS } = await import("~/lib/rooms");

/** One enforcement call per room: suspension and the kill switch fan out (VRIP-12). */
const EVERY_ROOM = ROOM_IDS.map(() => "do");

function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: "m1",
    userId: "u1",
    pseudonym: "quiet-ibex",
    isModerator: true,
    suspendedAt: null,
    suspendedReason: null,
    deletedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

/** Records the order calls arrive in, which is the property VRIP-08 fixes. */
let order: string[];

function room() {
  return {
    deleteMessage: vi.fn(async () => {
      order.push("do");
      return { ok: true };
    }),
    suspend: vi.fn(async () => {
      order.push("do");
    }),
    restore: vi.fn(async () => {
      order.push("do");
    }),
    setKilled: vi.fn(async () => {
      order.push("do");
      return { killed: true, at: 1 };
    }),
  };
}

beforeEach(() => {
  order = [];
  vi.clearAllMocks();
  getRoom.mockResolvedValue(room());
  findReport.mockResolvedValue({
    id: "r1",
    roomId: "campus-live",
    messageId: "msg1",
    snapshot: "text",
    reason: null,
    handle: "grumpy-heron",
    reportedMemberId: "m2",
    status: "open",
    createdAt: new Date(),
  });
  findMemberById.mockImplementation(async (id: string) =>
    id === "m1" ? member() : member({ id: "m2", pseudonym: "grumpy-heron" }),
  );
  setReportStatus.mockImplementation(async () => {
    order.push("neon");
    return true;
  });
  setSuspended.mockImplementation(async () => {
    order.push("neon");
    return null;
  });
  writeAudit.mockImplementation(async () => {
    order.push("audit");
    return { id: "a1" };
  });
});

const FIELDS = { reportId: "r1", memberId: "m2", killed: true };

describe("role enforcement", () => {
  it("refuses every action for a non-moderator", async () => {
    const student = member({ isModerator: false });
    for (const intent of MOD_INTENTS) {
      await expect(
        performModeration({ member: student, kind: "console" }, intent, FIELDS),
      ).rejects.toMatchObject({ code: "not_moderator" });
    }
    // Nothing reached enforcement or the record.
    expect(order).toEqual([]);
  });

  it("refuses a tombstoned moderator", async () => {
    const gone = member({ deletedAt: new Date() });
    await expect(
      performModeration({ member: gone, kind: "console" }, "suspend", FIELDS),
    ).rejects.toMatchObject({ code: "not_moderator" });
  });

  it("refuses every action for a suspended moderator", async () => {
    // Suspension is the product's only remedy against a moderator. A guard that
    // reads deletedAt but not suspendedAt leaves the suspended account the kill
    // switch and restore on itself.
    const suspended = member({ suspendedAt: new Date() });
    for (const intent of MOD_INTENTS) {
      await expect(
        performModeration(
          { member: suspended, kind: "console" },
          intent,
          FIELDS,
        ),
      ).rejects.toMatchObject({ code: "not_moderator" });
    }
    expect(order).toEqual([]);
  });

  it("refuses a device-key member even if it was flagged as a moderator", async () => {
    // Moderation needs an accountable person, so a handle with no V Auth
    // account behind it never acts, whatever its flag says (VRIP-13).
    const anonymous = member({ userId: null });
    for (const intent of MOD_INTENTS) {
      await expect(
        performModeration(
          { member: anonymous, kind: "script" },
          intent,
          FIELDS,
        ),
      ).rejects.toMatchObject({ code: "not_moderator" });
    }
    expect(order).toEqual([]);
  });

  it("refuses a suspended moderator at the script door too", async () => {
    const suspended = member({ suspendedAt: new Date() });
    await expect(
      performModeration({ member: suspended, kind: "script" }, "restore", {
        memberId: "m1",
      }),
    ).rejects.toMatchObject({ code: "not_moderator" });
  });

  it("applies the same check to the script front door", async () => {
    const student = member({ isModerator: false });
    await expect(
      performModeration(
        { member: student, kind: "script" },
        "set_room_state",
        FIELDS,
      ),
    ).rejects.toBeInstanceOf(ModerationError);
  });

  it("recognises exactly the five documented intents, and reveal is not one", () => {
    expect([...MOD_INTENTS].sort()).toEqual(
      [
        "delete_message",
        "dismiss_report",
        "restore",
        "set_room_state",
        "suspend",
      ].sort(),
    );
    expect(isModIntent("suspend")).toBe(true);
    expect(isModIntent("reveal")).toBe(false);
    expect(isModIntent("drop_database")).toBe(false);
  });
});

describe("ordering: enforcement first, record second", () => {
  it("suspends in every room before writing Neon and the audit row", async () => {
    await performModeration({ member: member(), kind: "console" }, "suspend", {
      memberId: "m2",
    });
    expect(order).toEqual([...EVERY_ROOM, "neon", "audit"]);
    expect(getRoom.mock.calls.map((call) => call[0]).sort()).toEqual(
      [...ROOM_IDS].sort(),
    );
  });

  it("also resolves the report when the suspension came from one", async () => {
    await performModeration(
      { member: member(), kind: "console" },
      "suspend",
      FIELDS,
    );
    expect(order).toEqual([...EVERY_ROOM, "neon", "neon", "audit"]);
  });

  it("restores in every room, so a restored handle is not still silenced somewhere", async () => {
    await performModeration({ member: member(), kind: "console" }, "restore", {
      memberId: "m2",
    });
    expect(order).toEqual([...EVERY_ROOM, "neon", "audit"]);
    expect(getRoom).toHaveBeenCalledTimes(ROOM_IDS.length);
  });

  it("deletes in the room the report names, and only there", async () => {
    findReport.mockResolvedValue({
      id: "r1",
      roomId: "hostel",
      messageId: "msg1",
      snapshot: "text",
      reason: null,
      handle: "grumpy-heron",
      reportedMemberId: "m2",
      status: "open",
      createdAt: new Date(),
    });
    await performModeration(
      { member: member(), kind: "console" },
      "delete_message",
      FIELDS,
    );
    expect(order).toEqual(["do", "neon", "audit"]);
    expect(getRoom).toHaveBeenCalledOnce();
    expect(getRoom).toHaveBeenCalledWith("hostel");
  });

  it("refuses a report naming a room this deployment does not serve", async () => {
    findReport.mockResolvedValue({
      id: "r1",
      roomId: "somewhere-else",
      messageId: "msg1",
      snapshot: "text",
      reason: null,
      handle: "grumpy-heron",
      reportedMemberId: "m2",
      status: "open",
      createdAt: new Date(),
    });
    await expect(
      performModeration(
        { member: member(), kind: "console" },
        "delete_message",
        FIELDS,
      ),
    ).rejects.toMatchObject({ code: "room_unreachable" });
    expect(order).toEqual([]);
  });

  it("closes every room before recording it, under one audit row", async () => {
    await performModeration(
      { member: member(), kind: "console" },
      "set_room_state",
      FIELDS,
    );
    expect(order).toEqual([...EVERY_ROOM, "audit"]);
    expect(writeAudit).toHaveBeenCalledOnce();
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "room_close", targetId: "all" }),
    );
  });

  it("writes nothing to Neon when the object is unreachable", async () => {
    getRoom.mockRejectedValue(new Error("no binding"));
    await expect(
      performModeration(
        { member: member(), kind: "console" },
        "suspend",
        FIELDS,
      ),
    ).rejects.toMatchObject({ code: "room_unreachable" });
    expect(order).toEqual([]);
    expect(setSuspended).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("writes nothing to Neon when one room of five is unreachable", async () => {
    getRoom.mockImplementation(async (id: string) => {
      if (id === "hostel") throw new Error("no binding");
      return room();
    });
    await expect(
      performModeration(
        { member: member(), kind: "console" },
        "suspend",
        FIELDS,
      ),
    ).rejects.toMatchObject({ code: "room_unreachable" });
    expect(setSuspended).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe("error paths", () => {
  it("reports a missing member", async () => {
    findMemberById.mockImplementation(async (id: string) =>
      id === "m1" ? member() : null,
    );
    await expect(
      performModeration({ member: member(), kind: "console" }, "suspend", {
        memberId: "m2",
      }),
    ).rejects.toMatchObject({ code: "member_not_found" });
  });

  it("refuses to suspend an account with no handle, since the object keys on it", async () => {
    findMemberById.mockImplementation(async (id: string) =>
      id === "m1" ? member() : member({ id: "m2", pseudonym: null }),
    );
    await expect(
      performModeration({ member: member(), kind: "console" }, "suspend", {
        memberId: "m2",
      }),
    ).rejects.toMatchObject({ code: "member_not_found" });
  });

  it("reports an already-closed report on dismiss", async () => {
    setReportStatus.mockResolvedValue(false);
    await expect(
      performModeration(
        { member: member(), kind: "console" },
        "dismiss_report",
        FIELDS,
      ),
    ).rejects.toMatchObject({ code: "already_resolved" });
  });

  it("dismiss has no object leg, because nothing a student can do changes", async () => {
    await performModeration(
      { member: member(), kind: "console" },
      "dismiss_report",
      FIELDS,
    );
    expect(order).toEqual(["neon", "audit"]);
  });
});
