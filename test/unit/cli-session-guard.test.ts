import { beforeEach, describe, expect, it, vi } from "vitest";

const findLiveCliSession = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
vi.mock("~/db/queries/cli-sessions", () => ({ findLiveCliSession }));
vi.mock("~/db/queries/members", () => ({
  listAccounts: query,
  countAccounts: query,
}));
vi.mock("~/db/queries/reports", () => ({
  listReports: query,
  countReports: query,
}));
vi.mock("~/db/queries/audit", () => ({ listAudit: query, countAudit: query }));
vi.mock("~/lib/policy.server", () => ({ drainPolicyFlags: query }));
vi.mock("~/lib/room.server", () => ({ readRoomStatus: query }));

const { requireCurrentModerator } =
  await import("~/lib/moderation-actor.server");
const { readModeration } = await import("~/lib/moderation-read.server");
const actor = {
  kind: "script" as const,
  sessionId: "10000000-0000-4000-8000-000000000001",
  tokenHash: "a".repeat(64),
  origin: "https://vrooms.test",
};

beforeEach(() => {
  vi.resetAllMocks();
  findLiveCliSession.mockResolvedValue({ id: actor.sessionId });
});

describe("shared live session boundary", () => {
  it.each([
    null,
    {},
    { kind: "script", sessionId: actor.sessionId },
    { ...actor, kind: "console" },
    { ...actor, tokenHash: "" },
    { ...actor, sessionId: "not-a-uuid" },
    { ...actor, origin: actor.origin + "/path" },
    { ...actor, origin: "not-a-url" },
    { ...actor, member: { isModerator: true }, tokenHash: undefined },
  ])(
    "rejects forged/incomplete actor %j before database or business",
    async (forged) => {
      await expect(
        requireCurrentModerator(forged as never),
      ).rejects.toMatchObject({ code: "bad_token" });
      expect(findLiveCliSession).not.toHaveBeenCalled();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(["reports", "accounts", "audit", "status"] as const)(
    "denies stale direct %s read before side effects",
    async (action) => {
      findLiveCliSession.mockResolvedValue(null);
      await expect(readModeration(actor, action, {})).rejects.toMatchObject({
        code: "bad_token",
      });
      expect(findLiveCliSession).toHaveBeenCalledWith(
        actor.tokenHash,
        actor.origin,
        actor.sessionId,
      );
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("denies a full actor when its hash or exact origin no longer matches", async () => {
    findLiveCliSession.mockImplementation(async (hash, origin, id) =>
      hash === actor.tokenHash &&
      origin === actor.origin &&
      id === actor.sessionId
        ? { id }
        : null,
    );
    for (const changed of [
      { ...actor, tokenHash: "b".repeat(64) },
      { ...actor, origin: "https://other.test" },
      { ...actor, sessionId: "20000000-0000-4000-8000-000000000001" },
    ]) {
      await expect(requireCurrentModerator(changed)).rejects.toMatchObject({
        code: "bad_token",
      });
    }
  });

  it("preserves safe DB-unavailable failure on direct reads", async () => {
    findLiveCliSession.mockRejectedValue(new Error("credential private"));
    await expect(readModeration(actor, "reports", {})).rejects.toMatchObject({
      code: "moderation_auth_unavailable",
      status: 503,
    });
    expect(query).not.toHaveBeenCalled();
  });
});
