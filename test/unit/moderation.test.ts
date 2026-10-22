import { describe, it, expect, vi, beforeEach } from "vitest";

import type { MemberRecord } from "~/db/queries/members";

const findMemberById = vi.fn();
const findLiveCliSession = vi.fn();
const setSuspended = vi.fn();
const findReport = vi.fn();
const setReportStatus = vi.fn();
const writeAudit = vi.fn();
const getRoom = vi.fn();

vi.mock("~/db/queries/cli-sessions", () => ({
  findLiveCliSession: (...a: unknown[]) => findLiveCliSession(...a),
}));
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
  findLiveCliSession.mockResolvedValue({ id: ACTOR.sessionId });
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

const ACTOR = {
  kind: "script" as const,
  sessionId: "10000000-0000-4000-8000-000000000001",
  tokenHash: "a".repeat(64),
  origin: "https://vrooms.test",
};

describe("session enforcement", () => {
  it("refuses stale sessions before every mutation", async () => {
    findLiveCliSession.mockResolvedValue(null);
    for (const intent of MOD_INTENTS) {
      await expect(
        performModeration(ACTOR, intent, FIELDS),
      ).rejects.toMatchObject({ code: "bad_token" });
    }
    expect(order).toEqual([]);
    expect(findMemberById).not.toHaveBeenCalled();
    expect(findReport).not.toHaveBeenCalled();
  });

  it("rechecks all credential fields at the shared boundary", async () => {
    await performModeration(ACTOR, "set_room_state", FIELDS);
    expect(findLiveCliSession).toHaveBeenCalledWith(
      ACTOR.tokenHash,
      ACTOR.origin,
      ACTOR.sessionId,
    );
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actorKind: "script",
        actorMemberId: null,
        details: { cliSessionId: ACTOR.sessionId },
      }),
    );
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

describe("CLI mutation audit", () => {
  it.each(MOD_INTENTS)(
    "snapshots a session and no member or credential for %s",
    async (intent) => {
      await performModeration(ACTOR, intent, FIELDS);
      expect(writeAudit).toHaveBeenCalledWith(
        expect.objectContaining({
          actorKind: "script",
          actorMemberId: null,
          details: expect.objectContaining({ cliSessionId: ACTOR.sessionId }),
        }),
      );
      const serialized = JSON.stringify(writeAudit.mock.calls);
      expect(serialized).not.toContain(ACTOR.tokenHash);
      expect(serialized).not.toContain(ACTOR.origin);
      if (["delete_message", "dismiss_report", "suspend"].includes(intent)) {
        expect(setReportStatus).toHaveBeenCalledWith(
          "r1",
          expect.any(String),
          null,
        );
      }
    },
  );
});

describe("ordering: enforcement first, record second", () => {
  it("suspends in every room before writing Neon and the audit row", async () => {
    await performModeration(ACTOR, "suspend", {
      memberId: "m2",
    });
    expect(order).toEqual([...EVERY_ROOM, "neon", "audit"]);
    expect(getRoom.mock.calls.map((call) => call[0]).sort()).toEqual(
      [...ROOM_IDS].sort(),
    );
  });

  it("also resolves the report when the suspension came from one", async () => {
    await performModeration(ACTOR, "suspend", FIELDS);
    expect(order).toEqual([...EVERY_ROOM, "neon", "neon", "audit"]);
  });

  it("restores in every room, so a restored handle is not still silenced somewhere", async () => {
    await performModeration(ACTOR, "restore", {
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
    await performModeration(ACTOR, "delete_message", FIELDS);
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
      performModeration(ACTOR, "delete_message", FIELDS),
    ).rejects.toMatchObject({ code: "room_unreachable" });
    expect(order).toEqual([]);
  });

  it("closes every room before recording it, under one audit row", async () => {
    await performModeration(ACTOR, "set_room_state", FIELDS);
    expect(order).toEqual([...EVERY_ROOM, "audit"]);
    expect(writeAudit).toHaveBeenCalledOnce();
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "room_close", targetId: "all" }),
    );
  });

  it("writes nothing to Neon when the object is unreachable", async () => {
    getRoom.mockRejectedValue(new Error("no binding"));
    await expect(
      performModeration(ACTOR, "suspend", FIELDS),
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
      performModeration(ACTOR, "suspend", FIELDS),
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
      performModeration(ACTOR, "suspend", {
        memberId: "m2",
      }),
    ).rejects.toMatchObject({ code: "member_not_found" });
  });

  it("refuses to suspend an account with no handle, since the object keys on it", async () => {
    findMemberById.mockImplementation(async (id: string) =>
      id === "m1" ? member() : member({ id: "m2", pseudonym: null }),
    );
    await expect(
      performModeration(ACTOR, "suspend", {
        memberId: "m2",
      }),
    ).rejects.toMatchObject({ code: "member_not_found" });
  });

  it("reports an already-closed report on dismiss", async () => {
    setReportStatus.mockResolvedValue(false);
    await expect(
      performModeration(ACTOR, "dismiss_report", FIELDS),
    ).rejects.toMatchObject({ code: "already_resolved" });
  });

  it("dismiss has no object leg, because nothing a student can do changes", async () => {
    await performModeration(ACTOR, "dismiss_report", FIELDS);
    expect(order).toEqual(["neon", "audit"]);
  });
});
