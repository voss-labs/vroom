import { describe, it, expect, vi, beforeEach } from "vitest";

import type { MemberRecord } from "~/db/queries/members";

/**
 * The three JSON endpoints, driven through their real actions. None of them had
 * a test at any level: the report door had no budget and no suspension check,
 * and the script door's bearer compare had no throttle.
 */

const readDeviceSession = vi.fn();
const findMemberByPseudonym = vi.fn();
const findMemberById = vi.fn();
const countRecentReportsBy = vi.fn();
const createReport = vi.fn();
const getMessage = vi.fn();

let roomReachable = true;
let roomsAsked: string[] = [];
const roomStub = {
  getMessage: (...a: unknown[]) => getMessage(...a),
};

vi.mock("~/lib/device-session.server", () => ({
  readDeviceSession: (...a: unknown[]) => readDeviceSession(...a),
}));
vi.mock("~/db/queries/members", () => ({
  findMemberByPseudonym: (...a: unknown[]) => findMemberByPseudonym(...a),
  findMemberById: (...a: unknown[]) => findMemberById(...a),
  claimPseudonym: vi.fn(),
  setSuspended: vi.fn(async () => null),
}));
vi.mock("~/db/queries/reports", () => ({
  countRecentReportsBy: (...a: unknown[]) => countRecentReportsBy(...a),
  createReport: (...a: unknown[]) => createReport(...a),
  findReport: vi.fn(async () => null),
  setReportStatus: vi.fn(async () => true),
}));
vi.mock("~/lib/room.server", () => ({
  RoomUnreachable: class RoomUnreachable extends Error {},
  getRoom: async (id: string) => {
    roomsAsked.push(id);
    return roomStub;
  },
  tryRoom: async (
    id: string,
    fn: (room: typeof roomStub) => Promise<unknown>,
  ) => {
    roomsAsked.push(id);
    return roomReachable ? fn(roomStub) : null;
  },
}));

const { action: report } = await import("~/routes/api.report");
const { action: socketToken } = await import("~/routes/api.socket-token");

const REPORT = { messageId: "msg1", roomId: "campus-live" };

type Args = Parameters<typeof report>[0];

function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: "m1",
    userId: null,
    pseudonym: "quiet-ibex",
    isModerator: false,
    suspendedAt: null,
    suspendedReason: null,
    deletedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function json(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  params: Record<string, string> = {},
): Args {
  return {
    request: new Request(`https://v-rooms.test${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        ...headers,
      },
    }),
    params,
    context: {},
  } as unknown as Args;
}

async function payload(response: Response) {
  return (await response.json()) as {
    data?: Record<string, unknown>;
    error?: { code: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  roomReachable = true;
  roomsAsked = [];
  process.env.APP_JWT_SECRET = "test-app-jwt-secret-value-not-a-real-one";
  readDeviceSession.mockResolvedValue("m1");
  findMemberById.mockResolvedValue(member());
  countRecentReportsBy.mockResolvedValue(0);
  createReport.mockResolvedValue({ id: "r1" });
  getMessage.mockResolvedValue({
    id: "msg1",
    seq: 4,
    who: "grumpy-heron",
    body: "said it",
    at: 1,
  });
  findMemberByPseudonym.mockResolvedValue(
    member({ id: "m2", pseudonym: "grumpy-heron" }),
  );
});

describe("POST /api/report", () => {
  it("files a report for a member in good standing", async () => {
    const response = await report(json("/api/report", REPORT));
    expect(response.status).toBe(200);
    expect((await payload(response)).data).toMatchObject({
      ok: true,
      duplicate: false,
    });
    expect(createReport).toHaveBeenCalledOnce();
  });

  it("refuses a suspended reporter", async () => {
    findMemberById.mockResolvedValue(member({ suspendedAt: new Date() }));
    const response = await report(json("/api/report", REPORT));

    expect(response.status).toBe(403);
    expect((await payload(response)).error?.code).toBe("suspended");
    expect(createReport).not.toHaveBeenCalled();
    // The object was never asked, so a suspended flood costs nothing either.
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("refuses a tombstoned reporter through the same check", async () => {
    findMemberById.mockResolvedValue(member({ deletedAt: new Date() }));
    const response = await report(json("/api/report", REPORT));
    expect(response.status).toBe(403);
    expect(createReport).not.toHaveBeenCalled();
  });

  it("stops a flood at the budget, before it reaches the object or the queue", async () => {
    countRecentReportsBy.mockResolvedValue(10);
    const response = await report(json("/api/report", REPORT));

    expect(response.status).toBe(429);
    expect((await payload(response)).error?.code).toBe("rate_limited");
    expect(createReport).not.toHaveBeenCalled();
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("counts the budget per member over a bounded window", async () => {
    await report(json("/api/report", REPORT));
    const [memberId, since] = countRecentReportsBy.mock.calls[0] as [
      string,
      Date,
    ];
    expect(memberId).toBe("m1");
    expect(Date.now() - since.getTime()).toBeGreaterThan(0);
    expect(Date.now() - since.getTime()).toBeLessThanOrEqual(
      10 * 60_000 + 5_000,
    );
  });

  it("refuses a cross-origin post before it touches the session", async () => {
    const response = await report(
      json("/api/report", REPORT, { "sec-fetch-site": "cross-site" }),
    );
    expect(response.status).toBe(403);
    expect((await payload(response)).error?.code).toBe("cross_origin");
    expect(readDeviceSession).not.toHaveBeenCalled();
  });

  it("still refuses an unauthenticated same-origin post", async () => {
    readDeviceSession.mockResolvedValue(null);
    const response = await report(json("/api/report", REPORT));
    expect(response.status).toBe(401);
  });

  it("will not let anyone report their own message", async () => {
    findMemberByPseudonym.mockResolvedValue(member({ id: "m1" }));
    const response = await report(json("/api/report", REPORT));
    expect(response.status).toBe(400);
    expect(createReport).not.toHaveBeenCalled();
  });

  it("refuses a report that names no room, or a room this deployment does not serve", async () => {
    for (const body of [
      { messageId: "msg1" },
      { messageId: "msg1", roomId: "somewhere-else" },
    ]) {
      const response = await report(json("/api/report", body));
      expect(response.status).toBe(400);
    }
    expect(getMessage).not.toHaveBeenCalled();
    expect(createReport).not.toHaveBeenCalled();
  });

  it("reads the message back from the room the report names, and records it", async () => {
    const response = await report(
      json("/api/report", { messageId: "msg1", roomId: "hostel" }),
    );
    expect(response.status).toBe(200);
    expect(roomsAsked).toEqual(["hostel"]);
    expect(createReport).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: "hostel" }),
    );
  });
});

describe("POST /api/socket-token", () => {
  it("refuses a cross-origin request", async () => {
    const response = await socketToken(
      json("/api/socket-token", {}, { "sec-fetch-site": "cross-site" }),
    );
    expect(response.status).toBe(403);
    expect((await payload(response)).error?.code).toBe("cross_origin");
    expect(readDeviceSession).not.toHaveBeenCalled();
  });

  it("refuses a suspended member a token", async () => {
    findMemberById.mockResolvedValue(member({ suspendedAt: new Date() }));
    const response = await socketToken(
      json("/api/socket-token", { roomId: "campus-live" }),
    );
    expect(response.status).toBe(403);
    expect((await payload(response)).error?.code).toBe("suspended");
  });

  it("mints a token for the room asked for, with that room's socket URL", async () => {
    const response = await socketToken(
      json("/api/socket-token", { roomId: "hostel" }),
    );
    expect(response.status).toBe(200);
    const { data } = await payload(response);
    expect(data?.pseudonym).toBe("quiet-ibex");
    expect(String(data?.wsUrl)).toContain("room=hostel");
    expect(typeof data?.token).toBe("string");
  });

  it("refuses a room this deployment does not serve, and a body with none", async () => {
    for (const body of [{}, { roomId: "somewhere-else" }, { roomId: 7 }]) {
      const response = await socketToken(json("/api/socket-token", body));
      expect(response.status).toBe(400);
      expect((await payload(response)).error?.code).toBe("unknown_room");
    }
    expect(readDeviceSession).not.toHaveBeenCalled();
  });
});
