import { describe, expect, it } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import {
  call,
  mocks,
  ACTIONS,
  payload,
  TOKEN,
  SESSION_ID,
} from "./moderation-api-fixture";

const { action, loader } = await import("~/routes/api.mod.$action");

function request(body: string, headers: Record<string, string> = {}) {
  return action({
    request: new Request("https://vrooms.test/api/mod/reports", {
      method: "POST",
      body,
      headers: { authorization: `Bearer ${TOKEN}`, ...headers },
    }),
    params: { action: "reports" },
    context: {},
  } as unknown as ActionFunctionArgs);
}

function noBusiness() {
  expect(mocks.findMemberByPseudonym).not.toHaveBeenCalled();
  expect(mocks.findMemberById).not.toHaveBeenCalled();
  expect(mocks.findReport).not.toHaveBeenCalled();
  expect(mocks.listReports).not.toHaveBeenCalled();
  expect(mocks.listAccounts).not.toHaveBeenCalled();
  expect(mocks.readRoomStatus).not.toHaveBeenCalled();
  expect(mocks.drainPolicyFlags).not.toHaveBeenCalled();
  expect(mocks.setKilled).not.toHaveBeenCalled();
  expect(mocks.writeAudit).not.toHaveBeenCalled();
}

describe("database CLI authentication", () => {
  it("refuses GET with uncacheable JSON", async () => {
    const response = loader();
    expect(response.status).toBe(405);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await payload(response)).error.code).toBe("method_not_allowed");
    noBusiness();
  });

  it("refuses cross-origin browsers before authentication", async () => {
    expect(
      (await request("{}", { "sec-fetch-site": "cross-site" })).status,
    ).toBe(403);
    expect(mocks.findLiveCliSession).not.toHaveBeenCalled();
    noBusiness();
  });

  it("refuses malformed JSON before draining", async () => {
    expect((await request("{")).status).toBe(400);
    noBusiness();
  });

  it.each([
    null,
    "",
    "incorrect",
    "a".repeat(42),
    "a".repeat(44),
    "a".repeat(100_000),
    "a".repeat(42) + "=",
    TOKEN + " extra",
  ])("rejects malformed bounded credential %s", async (token) => {
    for (const intent of ACTIONS)
      expect((await call(intent, {}, token)).status).toBe(401);
    expect(mocks.findLiveCliSession).not.toHaveBeenCalled();
    noBusiness();
  });

  it("rejects legacy credentials and cookies without fallback", async () => {
    process.env.MOD_SCRIPT_TOKEN = "legacy-credential";
    process.env.MOD_SCRIPT_MEMBER_HANDLE = "quiet-ibex";
    expect(
      (
        await request("{}", {
          authorization: "",
          cookie: "better-auth.session_token=old; vroom_device=old",
        })
      ).status,
    ).toBe(401);
    expect((await call("status", {}, "legacy-credential")).status).toBe(401);
    noBusiness();
  });

  it("uses SHA256 and exact request origin with V Auth off and no member bootstrap", async () => {
    expect(process.env.VAUTH_SIGN_IN).toBe("off");
    expect((await call("status")).status).toBe(200);
    const hash = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TOKEN)),
    ).toString("hex");
    expect(mocks.findLiveCliSession.mock.calls).toEqual([
      [hash, "https://vrooms.test", undefined],
      [hash, "https://vrooms.test", SESSION_ID],
    ]);
    expect(mocks.findMemberByPseudonym).not.toHaveBeenCalled();
    expect(mocks.findMemberById).not.toHaveBeenCalled();
    expect(mocks.drainPolicyFlags).not.toHaveBeenCalled();
    expect(mocks.checkScriptAuth).not.toHaveBeenCalled();
  });

  it.each([
    "unknown",
    "expired",
    "revoked",
    "deleted",
    "wrong origin",
    "rotated",
  ])("denies %s session uniformly before business", async () => {
    mocks.findLiveCliSession.mockResolvedValue(null);
    for (const intent of ACTIONS) {
      const response = await call(intent);
      expect(response.status).toBe(401);
      expect((await payload(response)).error).toEqual({
        code: "bad_token",
        message: "Invalid CLI session.",
      });
    }
    noBusiness();
  });

  it("rechecks a previously admitted session before target lookup and all operations", async () => {
    for (const intent of ACTIONS) {
      mocks.findLiveCliSession
        .mockResolvedValueOnce({ id: SESSION_ID })
        .mockResolvedValueOnce(null);
      const response = await call(intent, {
        handle: "grumpy-heron",
        killed: true,
        reportId: "r1",
      });
      expect(response.status).toBe(401);
    }
    noBusiness();
  });

  it("returns safe unavailable errors when DB lookup fails", async () => {
    mocks.findLiveCliSession.mockRejectedValue(
      new Error("postgres://private/token"),
    );
    const response = await call("reports");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("moderation_auth_unavailable");
    noBusiness();
  });

  it("charges invalid credentials to shared failure budget", async () => {
    mocks.checkScriptAuth.mockResolvedValue({ allowed: false, retryAfter: 42 });
    expect((await call("reports", {}, "incorrect")).status).toBe(429);
    expect(mocks.checkScriptAuth).toHaveBeenCalledWith(10);
  });

  it("still denies credentials when failure limiter is unavailable", async () => {
    mocks.checkScriptAuth.mockRejectedValue(new Error("private failure"));
    expect((await call("reports", {}, "incorrect")).status).toBe(401);
  });
});
