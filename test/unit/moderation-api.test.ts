import { describe, expect, it, vi } from "vitest";
import { call, mocks, DATE, ROOM_IDS, payload } from "./moderation-api-fixture";

describe("moderation reads", () => {
  it.each(["reports", "accounts", "audit"])(
    "returns an explicit empty %s page",
    async (intent) => {
      const response = await call(intent);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await payload(response)).data).toMatchObject({
        items: [],
        page: 0,
        pageSize: 25,
        total: 0,
        hasMore: false,
      });
    },
  );

  it.each([-1, 0.5, "1", null, 1_000_001, Number.MAX_SAFE_INTEGER])(
    "refuses invalid page %s before data reads",
    async (page) => {
      for (const intent of ["reports", "accounts", "audit"]) {
        expect((await call(intent, { page })).status).toBe(400);
      }
      expect(mocks.listReports).not.toHaveBeenCalled();
      expect(mocks.drainPolicyFlags).not.toHaveBeenCalled();
    },
  );

  it("awaits policy draining before querying retained report snapshots", async () => {
    let release!: () => void;
    mocks.drainPolicyFlags.mockImplementation(() =>
      new Promise<void>((resolve) => {
        release = () => resolve();
      }).then(() => ({ unreachable: false, unreachableRooms: [] })),
    );
    mocks.listReports.mockResolvedValue([
      {
        id: "r1",
        messageId: "expired",
        snapshot: "retained evidence",
        reason: "abuse",
        handle: "grumpy-heron",
        roomId: "hostel",
        status: "open",
        createdAt: DATE,
        reportedMemberId: "private-member",
        reporterMemberId: "private-reporter",
        keyHash: "private-key",
      },
    ]);
    mocks.countReports.mockResolvedValue(51);
    const pending = call("reports", { page: 1 });
    await vi.waitFor(() =>
      expect(mocks.drainPolicyFlags).toHaveBeenCalledOnce(),
    );
    expect(mocks.listReports).not.toHaveBeenCalled();
    release();
    const response = await pending;
    const { data } = await payload(response);
    expect(data).toEqual({
      items: [
        {
          id: "r1",
          messageId: "expired",
          snapshot: "retained evidence",
          reason: "abuse",
          handle: "grumpy-heron",
          roomId: "hostel",
          status: "open",
          createdAt: DATE.toISOString(),
        },
      ],
      page: 1,
      pageSize: 25,
      total: 51,
      hasMore: true,
      drain: { complete: true, unreachableRooms: [] },
    });
    expect(mocks.listReports).toHaveBeenCalledWith(1, 25);
    expect(mocks.deleteMessage).not.toHaveBeenCalled();
  });

  it("keeps the stored queue readable when one room fails to drain", async () => {
    mocks.drainPolicyFlags.mockResolvedValue({
      unreachable: true,
      unreachableRooms: ["hostel"],
    });
    const response = await call("reports");
    expect(response.status).toBe(200);
    expect((await payload(response)).data.drain).toEqual({
      complete: false,
      unreachableRooms: ["hostel"],
    });
    expect(mocks.listReports).toHaveBeenCalledOnce();
  });

  it("keeps the stored queue readable when the drain throws", async () => {
    mocks.drainPolicyFlags.mockRejectedValue(new Error("private failure"));
    const response = await call("reports");
    expect(response.status).toBe(200);
    expect((await payload(response)).data.drain).toEqual({
      complete: false,
      unreachableRooms: [...ROOM_IDS],
    });
  });

  it("returns handle-only accounts and real pagination metadata", async () => {
    mocks.listAccounts.mockResolvedValue([
      {
        id: "private-id",
        handle: "grumpy-heron",
        suspended: true,
        suspendedReason: "abuse",
        userId: "private-auth",
        email: "private@example.test",
        keyHash: "private-key",
      },
    ]);
    mocks.countAccounts.mockResolvedValue(27);
    const { data } = await payload(await call("accounts", { page: 1 }));
    expect(data).toEqual({
      items: [
        { handle: "grumpy-heron", suspended: true, suspendedReason: "abuse" },
      ],
      page: 1,
      pageSize: 25,
      total: 27,
      hasMore: false,
    });
    expect(mocks.listAccounts).toHaveBeenCalledWith(1, 25);
  });

  it("allowlists audit details and preserves historical actor kinds", async () => {
    mocks.listAudit.mockResolvedValue([
      {
        id: "a1",
        action: "auto_suspend",
        actorHandle: null,
        actorKind: "console",
        targetType: "member",
        targetId: "target",
        reportId: "r1",
        createdAt: DATE,
        actorMemberId: "private",
        email: "private@example.test",
        details: {
          handle: "grumpy-heron",
          reason: "abuse",
          email: "private@example.test",
          flagId: 7,
          userId: "private",
        },
      },
    ]);
    mocks.countAudit.mockResolvedValue(26);
    const { data } = await payload(await call("audit", { page: 1 }));
    expect(data.items[0]).toEqual({
      id: "a1",
      action: "auto_suspend",
      actorHandle: null,
      actorKind: "console",
      targetType: "member",
      targetId: "target",
      reportId: "r1",
      createdAt: DATE.toISOString(),
      details: { handle: "grumpy-heron", reason: "abuse" },
    });
    expect(mocks.listAudit).toHaveBeenCalledWith(1, 25);
  });

  it("preserves per-room status even when the aggregate is unavailable", async () => {
    const status = {
      rooms: [
        { roomId: "hostel", reachable: false },
        {
          roomId: "campus-live",
          reachable: true,
          online: 2,
          messages: 10,
          killed: false,
          killedAt: null,
          killedBy: null,
        },
      ],
      aggregate: null,
    };
    mocks.readRoomStatus.mockResolvedValue(status);
    expect((await payload(await call("status"))).data).toEqual(status);
  });

  it("returns safe errors when Neon fails", async () => {
    mocks.listAccounts.mockRejectedValue(
      new Error("postgres://private-credential"),
    );
    const response = await call("accounts");
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("private-credential");
  });
});
