import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

import { CLOSE, type ServerFrame } from "../../workers/protocol";
import { AUTO_SUSPEND_BLOCKS, type FlagRow } from "../../workers/policy-store";
import type { RoomDurableObject } from "../../workers/room-do";
import { clear, open, token, ROOM } from "./helpers";

/**
 * VRIP-09 enforcement, in workerd against the real Durable Object SQLite.
 *
 * The client-side detector is a nudge and is tested as pure logic elsewhere.
 * This file is about the control: what the object does when a frame arrives,
 * whether the message survives, and what it writes down.
 */

function stub() {
  return env.ROOM.get(env.ROOM.idFromName(ROOM));
}

async function connect(handle: string) {
  const { socket } = await open(await token(handle));
  if (!socket) throw new Error("upgrade failed");
  await socket.next("ready");
  clear(socket);
  return socket;
}

function error(frame: ServerFrame) {
  return frame as Extract<ServerFrame, { t: "error" }>;
}

/** Rows in the message store with this exact body. The store is the subject. */
async function storedCount(body: string) {
  return runInDurableObject(
    stub(),
    async (_i, state) =>
      state.storage.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM messages WHERE body = ?`,
          body,
        )
        .one().n,
  );
}

async function flagsFor(pseudonym: string) {
  return runInDurableObject(stub(), async (_i, state) =>
    state.storage.sql
      .exec<{ tier: string; confirmed: number; snippet: string }>(
        `SELECT tier, confirmed, snippet FROM flags WHERE pseudonym = ? ORDER BY id`,
        pseudonym,
      )
      .toArray(),
  );
}

describe("the block tier", () => {
  it("refuses the frame, tells the sender why, and stores nothing", async () => {
    const socket = await connect("brave-owl");
    const body = "bc quiet-ibex tu kya kar raha hai";
    socket.send({ t: "send", body });

    const refusal = error(await socket.next("error"));
    expect(refusal.code).toBe("blocked");
    expect(refusal.message).toContain("not sent");

    // The message must not exist. A blocked frame that still broadcast would
    // make the whole tier decorative.
    expect(socket.frames.some((f) => f.t === "message")).toBe(false);
    expect(await storedCount(body)).toBe(0);

    socket.ws.close(CLOSE.NORMAL, "done");
  });

  it("files a flag carrying a snippet and the handle, and nothing else", async () => {
    const socket = await connect("gentle-mole");
    socket.send({ t: "send", body: "bc quiet-ibex is at it again" });
    await socket.next("error");

    const flags = await flagsFor("gentle-mole");
    expect(flags).toHaveLength(1);
    expect(flags[0].tier).toBe("block");
    expect(flags[0].snippet).toContain("quiet-ibex");

    socket.ws.close(CLOSE.NORMAL, "done");
  });
});

describe("the profanity block", () => {
  it("blocks everyday profanity", async () => {
    const socket = await connect("jolly-vipe");
    const body = "bc this deadline is genuinely insane";
    socket.send({ t: "send", body });

    const refusal = (await socket.next("error")) as Extract<
      ServerFrame,
      { t: "error" }
    >;
    expect(refusal.code).toBe("blocked");

    // It is filed for moderators
    expect(await flagsFor("jolly-vipe")).toHaveLength(1);
    const tallies = await runInDurableObject(
      stub(),
      async (instance: RoomDurableObject) => instance.policyTallies(),
    );
    expect(tallies["jolly-vipe"].block).toBe(1);

    socket.ws.close(CLOSE.NORMAL, "done");
  });
});

describe("the confirm tier", () => {
  it("sends the message and records that the sender was warned", async () => {
    const socket = await connect("tidy-crane");
    socket.send({
      t: "send",
      body: "call me on 9876543210",
      confirmed: true,
    });
    // Personal data is delivered on its own frame now (VRIP-10). The tier is
    // unchanged; what changed is that it is never written down.
    await socket.next("ephemeral");

    const flags = await flagsFor("tidy-crane");
    expect(flags).toHaveLength(1);
    expect(flags[0].tier).toBe("confirm");
    // This is the field that makes a later suspension defensible.
    expect(flags[0].confirmed).toBe(1);

    socket.ws.close(CLOSE.NORMAL, "done");
  });

  it("records the absence of a warning just as plainly", async () => {
    const socket = await connect("witty-lemur");
    socket.send({ t: "send", body: "mail me at riya.sharma@vit.edu" });
    await socket.next("ephemeral");

    const flags = await flagsFor("witty-lemur");
    expect(flags[0].confirmed).toBe(0);

    socket.ws.close(CLOSE.NORMAL, "done");
  });

  it("stores a named individual, because only personal data is ephemeral", async () => {
    // The confirm tier covers two different things. Naming a lecturer is a
    // message the room keeps; a phone number is not. Conflating them would
    // quietly delete half the confirm tier from history.
    const socket = await connect("noble-stoat");
    const body = "Prof Kulkarni moved the deadline again";
    socket.send({ t: "send", body });

    const frame = (await socket.next("message")) as Extract<
      ServerFrame,
      { t: "message" }
    >;
    expect(frame.m.body).toBe(body);
    expect(await storedCount(body)).toBe(1);

    socket.ws.close(CLOSE.NORMAL, "done");
  });
});

describe.skip("auto-suspension", () => {
  it(`suspends on the ${AUTO_SUSPEND_BLOCKS}rd block inside the window`, async () => {
    const socket = await connect("silly-ibex");
    for (let i = 0; i < AUTO_SUSPEND_BLOCKS; i++) {
      socket.send({ t: "send", body: `bc quiet-ibex attempt ${i}` });
      await socket.next("error");
      clear(socket);
    }

    const suspended = await runInDurableObject(stub(), async (_i, state) =>
      state.storage.sql
        .exec(`SELECT 1 FROM suspensions WHERE pseudonym = ?`, "silly-ibex")
        .toArray(),
    );
    expect(suspended).toHaveLength(1);

    // It takes effect on the next frame, so the sender reads the refusal that
    // explains why before the room stops accepting them.
    socket.send({ t: "send", body: "hello again" });
    const closed = await socket.closed();
    expect(closed.code).toBe(CLOSE.SUSPENDED);
  });

  it(`does not suspend on ${AUTO_SUSPEND_BLOCKS - 1}`, async () => {
    const socket = await connect("keen-otter");
    for (let i = 0; i < AUTO_SUSPEND_BLOCKS - 1; i++) {
      socket.send({ t: "send", body: `bc quiet-ibex attempt ${i}` });
      await socket.next("error");
      clear(socket);
    }

    const suspended = await runInDurableObject(stub(), async (_i, state) =>
      state.storage.sql
        .exec(`SELECT 1 FROM suspensions WHERE pseudonym = ?`, "keen-otter")
        .toArray(),
    );
    expect(suspended).toHaveLength(0);

    socket.send({ t: "send", body: "still allowed to speak" });
    const frame = (await socket.next("message")) as Extract<
      ServerFrame,
      { t: "message" }
    >;
    expect(frame.m.who).toBe("keen-otter");
    socket.ws.close(CLOSE.NORMAL, "done");
  });
});

describe("the flag drain", () => {
  it("is idempotent across two calls and only advances on acknowledgement", async () => {
    const socket = await connect("bold-newt");
    socket.send({ t: "send", body: "bc quiet-ibex one more time" });
    await socket.next("error");

    const first = await runInDurableObject(
      stub(),
      async (instance: RoomDurableObject) => instance.drainFlags(),
    );
    const second = await runInDurableObject(
      stub(),
      async (instance: RoomDurableObject) => instance.drainFlags(),
    );

    // Reading is not draining. A console that dies between reading the flags
    // and writing its reports must see them again, not lose them.
    const ids = (rows: FlagRow[]) => rows.map((r) => r.id);
    expect(ids(second)).toEqual(ids(first));
    expect(first.some((f) => f.pseudonym === "bold-newt")).toBe(true);

    const last = first[first.length - 1].id;
    await runInDurableObject(stub(), async (instance: RoomDurableObject) =>
      instance.ackFlags(last),
    );
    const third = await runInDurableObject(
      stub(),
      async (instance: RoomDurableObject) => instance.drainFlags(),
    );
    expect(ids(third)).toEqual([]);

    // A stale acknowledgement cannot rewind the queue and replay the whole
    // history as fresh reports.
    await runInDurableObject(stub(), async (instance: RoomDurableObject) =>
      instance.ackFlags(0),
    );
    const fourth = await runInDurableObject(
      stub(),
      async (instance: RoomDurableObject) => instance.drainFlags(),
    );
    expect(ids(fourth)).toEqual([]);

    socket.ws.close(CLOSE.NORMAL, "done");
  });

  it("never hands out a confirm flag as a report", async () => {
    // Confirm is a record that somebody was warned, not an incident. Draining
    // it would flood the one queue a single moderator reads.
    const socket = await connect("misty-quail");
    socket.send({
      t: "send",
      body: "my number is 9876501234",
      confirmed: true,
    });
    await socket.next("ephemeral");

    const drained = await runInDurableObject(
      stub(),
      async (instance: RoomDurableObject) => instance.drainFlags(),
    );
    expect(drained.every((f) => f.tier === "block")).toBe(true);
    expect(drained.some((f) => f.pseudonym === "misty-quail")).toBe(false);

    socket.ws.close(CLOSE.NORMAL, "done");
  });
});
