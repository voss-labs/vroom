import { describe, expect, it } from "vitest";
import {
  call,
  mocks,
  member,
  ROOM_IDS,
  payload,
} from "./moderation-api-fixture";

describe("moderation mutation boundary", () => {
  it("reports every all-room enforcement outcome and writes no success audit after failure", async () => {
    mocks.setKilled.mockImplementation(async (roomId: string) => {
      if (roomId === "hostel") throw new Error("private-credential");
      return { killed: true, at: 123 };
    });
    const response = await call("set_room_state", { killed: true });
    expect(response.status).toBe(503);
    expect((await payload(response)).error).toEqual({
      code: "room_unreachable",
      message:
        "Some rooms could not be updated. Enforcement may already have happened in other rooms.",
      partial: true,
      rooms: ROOM_IDS.map((roomId) => ({
        roomId,
        reachable: roomId !== "hostel",
      })),
    });
    expect(mocks.setKilled).toHaveBeenCalledTimes(ROOM_IDS.length);
    expect(mocks.writeAudit).not.toHaveBeenCalled();
  });

  it("retains explicit handle mutation through the shared enforcement service", async () => {
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
    expect(
      (
        await call("suspend", {
          handle: "grumpy-heron",
          reason: "abuse",
          reportId: "r1",
        })
      ).status,
    ).toBe(200);
    expect(mocks.suspend).toHaveBeenCalledTimes(ROOM_IDS.length);
    expect(mocks.setSuspended).toHaveBeenCalledWith("target", true, "abuse");
    expect(mocks.writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actorKind: "script", actorMemberId: "actor" }),
    );
  });

  it("rejects invalid room state instead of reopening rooms", async () => {
    expect((await call("set_room_state", { killed: "true" })).status).toBe(400);
    expect(mocks.setKilled).not.toHaveBeenCalled();
  });

  it.each([null, [], "invalid"])(
    "rejects malformed JSON object body %s",
    async (body) => {
      expect((await call("reports", body)).status).toBe(400);
      expect(mocks.drainPolicyFlags).not.toHaveBeenCalled();
    },
  );
});
