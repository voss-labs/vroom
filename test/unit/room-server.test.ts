import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomStats } from "../../workers/room-do";
import type { RoomState } from "../../workers/room-sql";

const getStub = vi.hoisted(() => vi.fn());
vi.mock("cloudflare:workers", () => ({
  env: { ROOM: { idFromName: (name: string) => name, get: getStub } },
}));

const { readRoomStatus, getRoom, tryRoom, readRoomPulses } =
  await import("~/lib/room.server");
const { ROOM_IDS } = await import("~/lib/rooms");

function room(stats: Partial<RoomStats> = {}, state: Partial<RoomState> = {}) {
  return {
    stats: vi.fn(async () => ({
      total: 0,
      since: null,
      peakToday: 0,
      online: 0,
      members: [],
      ...stats,
    })),
    getRoomState: vi.fn(async () => ({
      killed: false,
      killedAt: null,
      killedBy: null,
      ...state,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getStub.mockImplementation(() => room());
});

describe("moderation room status", () => {
  it("reads every room and counts a student in two rooms once", async () => {
    getStub.mockImplementation((id: string) =>
      id === "campus-live"
        ? room({
            online: 2,
            total: 10,
            members: ["quiet-ibex", "grumpy-heron"],
          })
        : id === "hostel"
          ? room({
              online: 2,
              total: 5,
              members: ["grumpy-heron", "swift-heron"],
            })
          : room(),
    );
    const view = await readRoomStatus();
    expect(view.aggregate).toEqual({ online: 3, messages: 15, killed: false });
    expect(view.rooms).toHaveLength(ROOM_IDS.length);
    expect(view.rooms.find((item) => item.roomId === "hostel")).toMatchObject({
      reachable: true,
      online: 2,
      messages: 5,
    });
    expect(getStub.mock.calls.map(([id]) => id)).toEqual([...ROOM_IDS]);
  });

  it("preserves reachable room state during a partial outage and withholds totals", async () => {
    getStub.mockImplementation((id: string) => {
      if (id === "hostel") throw new Error("unreachable");
      return room(
        { total: 4, online: 1, members: ["quiet-ibex"] },
        { killed: true, killedAt: 123, killedBy: "quiet-ibex" },
      );
    });
    const view = await readRoomStatus();
    expect(view.aggregate).toBeNull();
    expect(view.rooms.find((item) => item.roomId === "hostel")).toEqual({
      roomId: "hostel",
      reachable: false,
    });
    expect(view.rooms.find((item) => item.roomId === "campus-live")).toEqual({
      roomId: "campus-live",
      reachable: true,
      online: 1,
      messages: 4,
      killed: true,
      killedAt: 123,
      killedBy: "quiet-ibex",
    });
  });

  it("treats a failed stats or state RPC as an unreachable room", async () => {
    getStub.mockImplementation((id: string) => {
      const stub = room();
      if (id === "hostel") stub.stats.mockRejectedValue(new Error("no stats"));
      if (id === "campus-live")
        stub.getRoomState.mockRejectedValue(new Error("no state"));
      return stub;
    });
    const view = await readRoomStatus();
    expect(view.aggregate).toBeNull();
    expect(
      view.rooms.filter((item) => !item.reachable).map((item) => item.roomId),
    ).toEqual(["campus-live", "hostel"]);
  });

  it("reports closed globally only when every room is closed", async () => {
    getStub.mockImplementation(() => room({}, { killed: true }));
    expect((await readRoomStatus()).aggregate?.killed).toBe(true);
    getStub.mockImplementation((id: string) =>
      room({}, { killed: id !== "hostel" }),
    );
    expect((await readRoomStatus()).aggregate?.killed).toBe(false);
  });

  it("projects only a handle for historical kill-switch attribution", async () => {
    getStub.mockImplementation(() =>
      room({}, { killedBy: "private-auth-user-id" }),
    );
    const view = await readRoomStatus();
    expect(
      view.rooms.every((item) => item.reachable && item.killedBy === null),
    ).toBe(true);
  });

  it("degrades to explicit unreachable rooms when all objects fail", async () => {
    getStub.mockImplementation(() => {
      throw new Error("no binding");
    });
    expect(await readRoomStatus()).toEqual({
      rooms: ROOM_IDS.map((roomId) => ({ roomId, reachable: false })),
      aggregate: null,
    });
  });
});

describe("shared room binding helpers", () => {
  it("resolves the requested room binding", async () => {
    await getRoom("hostel");
    expect(getStub).toHaveBeenCalledWith("hostel");
  });

  it("swallows an unreachable room without leaking raw errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    getStub.mockImplementation(() => {
      throw new Error("private-credential");
    });
    expect(await tryRoom("hostel", async (stub) => stub.stats())).toBeNull();
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-credential");
    log.mockRestore();
  });

  it("keeps the public room-pulse shape and failure behavior", async () => {
    expect(await readRoomPulses()).toEqual(
      Object.fromEntries(
        ROOM_IDS.map((roomId) => [
          roomId,
          { roomId, online: 0, messages: 0, killed: false },
        ]),
      ),
    );
    getStub.mockImplementation((id: string) => {
      if (id === "hostel") throw new Error("offline");
      return room();
    });
    expect(await readRoomPulses()).toBeNull();
  });
});
