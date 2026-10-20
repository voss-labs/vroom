import { beforeEach, describe, expect, it } from "vitest";
import { call, mocks, member, DATE, payload } from "./moderation-api-fixture";

function storedReport(overrides: Record<string, unknown> = {}) {
  return {
    id: "r1",
    roomId: "hostel",
    messageId: "legacy-message",
    snapshot: "retained evidence",
    handle: "Local Dev",
    suspendHandle: null,
    reportedMemberId: null,
    status: "open",
    createdAt: DATE,
    ...overrides,
  };
}

function assertNoMutation() {
  expect(mocks.suspend).not.toHaveBeenCalled();
  expect(mocks.setSuspended).not.toHaveBeenCalled();
  expect(mocks.setReportStatus).not.toHaveBeenCalled();
  expect(mocks.writeAudit).not.toHaveBeenCalled();
}

beforeEach(() => {
  mocks.findMemberByPseudonym.mockImplementation(async (handle: string) =>
    handle === "quiet-ibex"
      ? member()
      : member({
          id: "target",
          pseudonym: handle,
          userId: null,
          isModerator: false,
        }),
  );
  mocks.findMemberById.mockImplementation(async (id: string) =>
    id === "actor"
      ? member()
      : member({
          id,
          pseudonym: "grumpy-heron",
          userId: null,
          isModerator: false,
        }),
  );
});

describe("report-bound suspension", () => {
  it.each([
    [null, "report_target_unavailable"],
    ["target", "report_target_mismatch"],
  ])(
    "classifies a missing supplied handle from the persisted report target %s",
    async (targetId, code) => {
      mocks.findMemberByPseudonym.mockImplementation(async (handle: string) =>
        handle === "quiet-ibex" ? member() : null,
      );
      mocks.findReport.mockResolvedValue(
        storedReport({ reportedMemberId: targetId }),
      );
      const response = await call("suspend", {
        handle: "Local Dev",
        reportId: "r1",
      });
      expect(response.status).toBe(409);
      expect((await payload(response)).error.code).toBe(code);
      assertNoMutation();
    },
  );

  it("keeps unknown standalone and restore handles as missing accounts", async () => {
    mocks.findMemberByPseudonym.mockImplementation(async (handle: string) =>
      handle === "quiet-ibex" ? member() : null,
    );
    for (const [action, body] of [
      ["suspend", { handle: "Local Dev" }],
      ["restore", { handle: "Local Dev", reportId: "r1" }],
    ] as const) {
      const response = await call(action, body);
      expect(response.status).toBe(404);
      expect((await payload(response)).error.code).toBe("member_not_found");
    }
    expect(mocks.findReport).not.toHaveBeenCalled();
    assertNoMutation();
  });

  it.each([undefined, ""])(
    "still rejects absent or empty handle input %s",
    async (handle) => {
      expect((await call("suspend", { handle, reportId: "r1" })).status).toBe(
        400,
      );
      expect(mocks.findReport).not.toHaveBeenCalled();
      assertNoMutation();
    },
  );

  it("returns retained labels without exposing or inventing an account target", async () => {
    mocks.listReports.mockResolvedValue([storedReport()]);
    mocks.countReports.mockResolvedValue(1);
    const response = await call("reports");
    const item = (await payload(response)).data.items[0];
    expect(item).toMatchObject({
      handle: "Local Dev",
      suspendHandle: null,
      snapshot: "retained evidence",
    });
    expect(item).not.toHaveProperty("reportedMemberId");
  });

  it("refuses a direct API request targeting another account from orphaned evidence", async () => {
    mocks.findReport.mockResolvedValue(storedReport());
    const response = await call("suspend", {
      handle: "grumpy-heron",
      reportId: "r1",
    });
    expect(response.status).toBe(409);
    expect((await payload(response)).error.code).toBe(
      "report_target_unavailable",
    );
    assertNoMutation();
  });

  it("refuses a direct API request that mismatches the persisted report account", async () => {
    mocks.findReport.mockResolvedValue(
      storedReport({
        reportedMemberId: "different-target",
        suspendHandle: "swift-heron",
      }),
    );
    const response = await call("suspend", {
      handle: "grumpy-heron",
      reportId: "r1",
    });
    expect(response.status).toBe(409);
    expect((await payload(response)).error.code).toBe("report_target_mismatch");
    assertNoMutation();
  });

  it.each([
    null,
    member({ id: "target", deletedAt: DATE }),
    member({ id: "target", pseudonym: null }),
  ])(
    "refuses a persisted target that is no longer a live account",
    async (target) => {
      mocks.findReport.mockResolvedValue(
        storedReport({ reportedMemberId: "target" }),
      );
      mocks.findMemberById.mockImplementation(async (id: string) =>
        id === "actor" ? member() : target,
      );
      const response = await call("suspend", {
        handle: "grumpy-heron",
        reportId: "r1",
      });
      expect(response.status).toBe(409);
      expect((await payload(response)).error.code).toBe(
        "report_target_unavailable",
      );
      assertNoMutation();
    },
  );

  it("allows delete and dismiss on a stored report without an account", async () => {
    mocks.findReport.mockResolvedValue(storedReport());
    expect((await call("delete_message", { reportId: "r1" })).status).toBe(200);
    expect(mocks.deleteMessage).toHaveBeenCalledWith("legacy-message");
    expect((await call("dismiss_report", { reportId: "r1" })).status).toBe(200);
    expect(mocks.setReportStatus).toHaveBeenCalledWith("r1", "dismissed", null);
  });

  it("keeps standalone account suspension available", async () => {
    expect((await call("suspend", { handle: "grumpy-heron" })).status).toBe(
      200,
    );
    expect(mocks.suspend).toHaveBeenCalled();
    expect(mocks.findReport).not.toHaveBeenCalled();
  });

  it("suspends only the current linked account before resolving and auditing the report", async () => {
    mocks.findReport.mockResolvedValue(
      storedReport({
        reportedMemberId: "target",
        suspendHandle: "grumpy-heron",
      }),
    );
    expect(
      (await call("suspend", { handle: "grumpy-heron", reportId: "r1" }))
        .status,
    ).toBe(200);
    expect(mocks.suspend).toHaveBeenCalledWith("grumpy-heron");
    expect(Math.max(...mocks.suspend.mock.invocationCallOrder)).toBeLessThan(
      mocks.setSuspended.mock.invocationCallOrder[0],
    );
    expect(mocks.setSuspended.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.setReportStatus.mock.invocationCallOrder[0],
    );
    expect(mocks.setReportStatus.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.writeAudit.mock.invocationCallOrder[0],
    );
  });

  it("retains authorization for every action against accountless evidence", async () => {
    mocks.findReport.mockResolvedValue(storedReport());
    mocks.findLiveCliSession.mockResolvedValue(null);
    for (const action of ["delete_message", "dismiss_report", "suspend"]) {
      expect(
        (await call(action, { handle: "grumpy-heron", reportId: "r1" })).status,
      ).toBe(401);
    }
    expect(mocks.findReport).not.toHaveBeenCalled();
    expect(mocks.deleteMessage).not.toHaveBeenCalled();
    assertNoMutation();
  });
});
