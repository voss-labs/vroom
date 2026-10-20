import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberRecord } from "~/db/queries/members";

const resolveActor = vi.fn();
const findTarget = vi.fn();
const createReport = vi.fn();
const countRecent = vi.fn();
const getMessage = vi.fn();
let reachable = true;
vi.mock("~/lib/require-role.server", () => ({ resolveActor }));
vi.mock("~/db/queries/members", () => ({ findMemberByPseudonym: findTarget }));
vi.mock("~/db/queries/reports", () => ({
  createReport,
  countRecentReportsBy: countRecent,
}));
vi.mock("~/lib/room.server", () => ({
  tryRoom: async (_room: string, fn: (stub: unknown) => unknown) =>
    reachable ? fn({ getMessage }) : null,
}));
const { action } = await import("~/routes/api.report");
const reporter: MemberRecord = {
  id: "reporter-device",
  userId: null,
  pseudonym: "wise-seal",
  isModerator: false,
  suspendedAt: null,
  suspendedReason: null,
  deletedAt: null,
  createdAt: new Date(),
};
const message = {
  id: "legacy-message",
  seq: 1,
  who: "Local Dev",
  body: "retained authoritative evidence",
  at: Date.now(),
};

function request(
  body: unknown = { roomId: "campus-live", messageId: message.id },
) {
  return {
    request: new Request("https://vroom.example/api/report", {
      method: "POST",
      headers: {
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  reachable = true;
  resolveActor.mockResolvedValue({ kind: "device", member: reporter });
  findTarget.mockResolvedValue(null);
  countRecent.mockResolvedValue(0);
  createReport.mockResolvedValue({ id: "report-1" });
  getMessage.mockResolvedValue(message);
});

describe("reports of retained author evidence", () => {
  it("lets wise-seal report Local Dev without fabricating a target member", async () => {
    const response = await action(request());
    expect(response.status).toBe(200);
    expect(createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reporterMemberId: reporter.id,
        reportedMemberId: null,
        authorHandle: "Local Dev",
        messageSnapshot: message.body,
      }),
    );
  });

  it("retains a deleted author's evidence without an actionable member link", async () => {
    findTarget.mockResolvedValue({
      ...reporter,
      id: "deleted-author",
      pseudonym: "brave-ibex",
      deletedAt: new Date(),
    });
    getMessage.mockResolvedValue({ ...message, who: "brave-ibex" });
    expect((await action(request())).status).toBe(200);
    expect(createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportedMemberId: null,
        authorHandle: "brave-ibex",
      }),
    );
  });

  it("keeps a normal current member link and snapshots only DO-authoritative fields", async () => {
    findTarget.mockResolvedValue({
      ...reporter,
      id: "real-author",
      pseudonym: "brave-ibex",
    });
    getMessage.mockResolvedValue({ ...message, who: "brave-ibex" });
    expect(
      (
        await action(
          request({
            roomId: "campus-live",
            messageId: message.id,
            authorHandle: "forged-label",
            messageSnapshot: "forged body",
            reportedMemberId: reporter.id,
          }),
        )
      ).status,
    ).toBe(200);
    expect(createReport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportedMemberId: "real-author",
        authorHandle: "brave-ibex",
        messageSnapshot: message.body,
      }),
    );
  });

  it("refuses a self-report by authoritative handle even without a lookup result", async () => {
    getMessage.mockResolvedValue({ ...message, who: reporter.pseudonym });
    expect((await action(request())).status).toBe(400);
    expect(createReport).not.toHaveBeenCalled();
  });

  it("refuses a self-report by linked ID even when the label differs", async () => {
    findTarget.mockResolvedValue(reporter);
    expect((await action(request())).status).toBe(400);
    expect(createReport).not.toHaveBeenCalled();
  });

  it("treats a duplicate as successful evidence already filed", async () => {
    createReport.mockResolvedValue(null);
    const response = await action(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: { ok: true, duplicate: true },
    });
  });

  it.each([null, [], 7, "text", false])(
    "rejects non-object JSON %j safely",
    async (body) => {
      const response = await action(request(body));
      expect(response.status).toBe(400);
      expect(createReport).not.toHaveBeenCalled();
      expect(getMessage).not.toHaveBeenCalled();
    },
  );

  it("does not accept an expired message from stale browser state", async () => {
    getMessage.mockResolvedValue(null);
    const response = await action(request());
    expect(response.status).toBe(404);
    expect(createReport).not.toHaveBeenCalled();
  });

  it("keeps an outage distinct from an absent message", async () => {
    reachable = false;
    expect((await action(request())).status).toBe(503);
    expect(createReport).not.toHaveBeenCalled();
  });

  it("returns a safe failure on a database error without echoing internal details", async () => {
    countRecent.mockRejectedValue(new Error("private database details"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await action(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private database details");
    vi.restoreAllMocks();
  });

  it("preserves device authentication and report budgets", async () => {
    resolveActor.mockResolvedValue(null);
    expect((await action(request())).status).toBe(401);
    resolveActor.mockResolvedValue({ kind: "device", member: reporter });
    countRecent.mockResolvedValue(10);
    expect((await action(request())).status).toBe(429);
    expect(createReport).not.toHaveBeenCalled();
  });
});
