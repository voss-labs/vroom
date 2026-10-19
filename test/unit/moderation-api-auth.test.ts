import { describe, expect, it } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import {
  call,
  mocks,
  member,
  DATE,
  ACTIONS,
  payload,
} from "./moderation-api-fixture";

const { action, loader } = await import("~/routes/api.mod.$action");

describe("script authentication and authorization", () => {
  it("refuses GET and unsupported action methods with uncacheable JSON", async () => {
    const responses = [
      loader(),
      await action({
        request: new Request("https://vrooms.test/api/mod/reports", {
          method: "DELETE",
        }),
        params: { action: "reports" },
        context: {},
      } as unknown as ActionFunctionArgs),
    ];
    for (const response of responses) {
      expect(response.status).toBe(405);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await payload(response)).error.code).toBe("method_not_allowed");
    }
    expect(mocks.findMemberByPseudonym).not.toHaveBeenCalled();
  });

  it("refuses an explicitly cross-origin browser before authentication", async () => {
    const response = await action({
      request: new Request("https://vrooms.test/api/mod/reports", {
        method: "POST",
        body: "{}",
        headers: {
          "sec-fetch-site": "cross-site",
          authorization: `Bearer ${process.env.MOD_SCRIPT_TOKEN}`,
        },
      }),
      params: { action: "reports" },
      context: {},
    } as unknown as ActionFunctionArgs);
    expect(response.status).toBe(403);
    expect((await payload(response)).error.code).toBe("cross_origin");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.findMemberByPseudonym).not.toHaveBeenCalled();
  });

  it("refuses malformed JSON before report draining", async () => {
    const response = await action({
      request: new Request("https://vrooms.test/api/mod/reports", {
        method: "POST",
        body: "{",
        headers: { authorization: `Bearer ${process.env.MOD_SCRIPT_TOKEN}` },
      }),
      params: { action: "reports" },
      context: {},
    } as unknown as ActionFunctionArgs);
    expect(response.status).toBe(400);
    expect(mocks.drainPolicyFlags).not.toHaveBeenCalled();
  });

  it("refuses a missing designated moderator or server credential", async () => {
    delete process.env.MOD_SCRIPT_MEMBER_HANDLE;
    expect((await call("reports")).status).toBe(500);
    process.env.MOD_SCRIPT_MEMBER_HANDLE = "quiet-ibex";
    mocks.findMemberByPseudonym.mockResolvedValue(null);
    expect((await call("reports")).status).toBe(403);
    delete process.env.MOD_SCRIPT_TOKEN;
    expect((await call("reports", {}, "previous-credential")).status).toBe(401);
    expect(mocks.drainPolicyFlags).not.toHaveBeenCalled();
  });
  it.each([null, "incorrect"])(
    "refuses missing or invalid bearer %s before any query or drain",
    async (token) => {
      for (const intent of ACTIONS) {
        const response = await call(intent, {}, token);
        expect(response.status).toBe(401);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
      expect(mocks.findMemberByPseudonym).not.toHaveBeenCalled();
      expect(mocks.listReports).not.toHaveBeenCalled();
      expect(mocks.drainPolicyFlags).not.toHaveBeenCalled();
    },
  );

  it("charges failed authentication to shared room state", async () => {
    mocks.checkScriptAuth.mockResolvedValue({ allowed: false, retryAfter: 42 });
    const response = await call("reports", {}, "incorrect");
    expect(response.status).toBe(429);
    expect(mocks.checkScriptAuth).toHaveBeenCalledWith(10);
  });

  it("valid operations never use or exhaust the failed-auth budget", async () => {
    mocks.checkScriptAuth.mockResolvedValue({ allowed: false, retryAfter: 42 });
    for (let i = 0; i < 12; i++)
      expect((await call("accounts")).status).toBe(200);
    expect(mocks.checkScriptAuth).not.toHaveBeenCalled();
  });

  it("still refuses a bad token when the failure limiter is unavailable", async () => {
    mocks.checkScriptAuth.mockRejectedValue(new Error("private failure"));
    expect((await call("reports", {}, "incorrect")).status).toBe(401);
  });

  it.each([
    { isModerator: false },
    { suspendedAt: DATE },
    { deletedAt: DATE },
    { userId: null },
  ])(
    "refuses an unauthorized designated actor %j before all operations",
    async (overrides) => {
      mocks.findMemberByPseudonym.mockResolvedValue(member(overrides));
      for (const intent of ACTIONS)
        expect((await call(intent)).status).toBe(403);
      expect(mocks.drainPolicyFlags).not.toHaveBeenCalled();
      expect(mocks.findMemberById).not.toHaveBeenCalled();
      expect(mocks.setKilled).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    member({ suspendedAt: DATE }),
    member({ isModerator: false }),
    member({ userId: null }),
    member({ deletedAt: DATE }),
  ])(
    "rechecks the current database actor before reads and mutations",
    async (current) => {
      mocks.findMemberById.mockResolvedValue(current);
      for (const intent of ACTIONS) {
        const response = await call(intent, {
          handle: "grumpy-heron",
          killed: true,
          reportId: "r1",
        });
        expect(response.status).toBe(403);
      }
      expect(mocks.drainPolicyFlags).not.toHaveBeenCalled();
      expect(mocks.listAccounts).not.toHaveBeenCalled();
      expect(mocks.setKilled).not.toHaveBeenCalled();
    },
  );
});
