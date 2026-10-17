import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

import { CLOSE, PAGE_SIZE, type ServerFrame } from "../../workers/protocol";
import type { RoomDurableObject } from "../../workers/room-do";
import { clear, open, token, ROOM } from "./helpers";

/**
 * VRIP-10, against the real Durable Object SQLite.
 *
 * The property under test is the absence of a write, not the disappearance of a
 * row. Every assertion here about "not stored" reads the `messages` table
 * directly rather than asking the object for a page, because a row that exists
 * and is filtered out of a query has not been protected — it is one query away
 * from being read, and the whole VRIP is that it is not there to read.
 */

const NUMBER = "9876543210";
const PERSONAL = `call me on ${NUMBER}`;

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

function ephemeral(frame: ServerFrame) {
  return frame as Extract<ServerFrame, { t: "ephemeral" }>;
}

/** Every row in the message store, unfiltered. No query stands between these. */
async function allRows() {
  return runInDurableObject(stub(), async (_i, state) =>
    state.storage.sql
      .exec<{ body: string }>(`SELECT body FROM messages`)
      .toArray(),
  );
}

/** Rows in the message store with this exact body. */
async function storedBody(body: string) {
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
      .exec<{ tier: string; matches: string; snippet: string }>(
        `SELECT tier, matches, snippet FROM flags WHERE pseudonym = ? ORDER BY id`,
        pseudonym,
      )
      .toArray(),
  );
}

describe("a message whose highest tier is personal data", () => {
  it("is broadcast to the room and written nowhere", async () => {
    const socket = await connect("swift-heron");
    socket.send({ t: "send", body: PERSONAL, confirmed: true });

    const frame = ephemeral(await socket.next("ephemeral"));
    expect(frame.m.body).toBe(PERSONAL);
    expect(frame.m.who).toBe("swift-heron");
    // The delivery frame carries no seq, because seq is the store's own key.
    expect("seq" in frame.m).toBe(false);

    // The whole table, not a page of it.
    const rows = await allRows();
    expect(rows.some((row) => row.body.includes(NUMBER))).toBe(false);

    socket.ws.close(CLOSE.NORMAL, "done");
  });

  it("reaches the other people in the room, which is who it was for", async () => {
    const sender = await connect("eager-tapir");
    const listener = await connect("calm-marten");

    sender.send({ t: "send", body: "my number is 9811122233" });
    const heard = ephemeral(await listener.next("ephemeral"));
    expect(heard.m.body).toBe("my number is 9811122233");

    sender.ws.close(CLOSE.NORMAL, "done");
    listener.ws.close(CLOSE.NORMAL, "done");
  });

  it("is absent from the page a later arrival is handed", async () => {
    const first = await connect("wise-tapir");
    first.send({ t: "send", body: "ping me on 9876512345" });
    await first.next("ephemeral");
    first.send({ t: "send", body: "and the notes are on the drive" });
    await first.next("message");
    first.ws.close(CLOSE.NORMAL, "done");

    // Somebody who was not in the room a minute ago. This is the harvesting
    // case the VRIP exists to close, so the join page is read before it is
    // cleared rather than going through the connect helper.
    const { socket: later } = await open(await token("late-badger"));
    if (!later) throw new Error("upgrade failed");
    const ready = (await later.next("ready")) as Extract<
      ServerFrame,
      { t: "ready" }
    >;
    expect(ready.messages.some((m) => m.body.includes("9876512345"))).toBe(
      false,
    );
    // The page is genuinely a page, so the assertion above is not vacuous.
    expect(ready.messages.some((m) => m.body.includes("on the drive"))).toBe(
      true,
    );

    later.ws.close(CLOSE.NORMAL, "done");
  });

  it("is absent from a backfill, at any cursor", async () => {
    const socket = await connect("keen-vole");
    socket.send({ t: "send", body: "reach me at 9876598765" });
    await socket.next("ephemeral");
    socket.send({ t: "send", body: "anyway back to the lab report" });
    await socket.next("message");
    clear(socket);

    // Paging from beyond the newest row walks the entire store.
    socket.send({ t: "history", before: 1e9, limit: PAGE_SIZE });
    const page = (await socket.next("history")) as Extract<
      ServerFrame,
      { t: "history" }
    >;
    expect(page.messages.some((m) => m.body.includes("9876598765"))).toBe(
      false,
    );
    expect(page.messages.some((m) => m.body.includes("lab report"))).toBe(true);

    socket.ws.close(CLOSE.NORMAL, "done");
  });

  it("still counts against the rate limit", async () => {
    // Not persisting is not a discount. RATE_LIMIT_MESSAGES_PER_MINUTE is 3 in
    // the test environment, so the fourth frame is refused whatever it says.
    const socket = await connect("brisk-finch");
    for (const digits of ["9811111111", "9822222222", "9833333333"]) {
      socket.send({ t: "send", body: `call me on ${digits}` });
      await socket.next("ephemeral");
      clear(socket);
    }

    socket.send({ t: "send", body: "an ordinary sentence" });
    const refusal = (await socket.next("error")) as Extract<
      ServerFrame,
      { t: "error" }
    >;
    expect(refusal.code).toBe("rate_limited");
    expect(await storedBody("an ordinary sentence")).toBe(0);

    socket.ws.close(CLOSE.NORMAL, "done");
  });

  it("still counts toward the policy tally", async () => {
    const socket = await connect("plain-marten");
    socket.send({ t: "send", body: "whatsapp me on 9876540000" });
    await socket.next("ephemeral");

    const tallies = await runInDurableObject(
      stub(),
      async (instance: RoomDurableObject) => instance.policyTallies(),
    );
    expect(tallies["plain-marten"].confirm).toBe(1);

    socket.ws.close(CLOSE.NORMAL, "done");
  });
});

describe("two tiers in one message", () => {
  it("delivers a phone number ephemerally", async () => {
    // A number is the confirm tier. It sends, it is tallied, and it is not stored.
    const socket = await connect("wry-otter");
    const body = "just call me on 9876543211";
    socket.send({ t: "send", body });

    const frame = ephemeral(await socket.next("ephemeral"));
    expect(frame.m.body).toBe(body);
    expect(await storedBody(body)).toBe(0);

    socket.ws.close(CLOSE.NORMAL, "done");
  });

  it("refuses profanity aimed at a handle even with a number in it, because block outranks confirm", async () => {
    // Block is higher still, and a refused message is not delivered at all —
    // so there is nothing to make ephemeral. The sender is told why.
    const socket = await connect("stern-crane");
    const body = "bc quiet-ibex call me on 9876543212";
    socket.send({ t: "send", body });

    const refusal = (await socket.next("error")) as Extract<
      ServerFrame,
      { t: "error" }
    >;
    expect(refusal.code).toBe("blocked");
    expect(socket.frames.some((f) => f.t === "ephemeral")).toBe(false);
    expect(socket.frames.some((f) => f.t === "message")).toBe(false);
    expect(await storedBody(body)).toBe(0);

    socket.ws.close(CLOSE.NORMAL, "done");
  });
});

describe("the flag for a personal-data message", () => {
  it("records the kind and never the value", async () => {
    const socket = await connect("mild-heron");
    socket.send({ t: "send", body: PERSONAL, confirmed: true });
    await socket.next("ephemeral");

    const flags = await flagsFor("mild-heron");
    expect(flags).toHaveLength(1);
    expect(flags[0].tier).toBe("confirm");
    expect(flags[0].matches).toContain("a phone number");
    // The specific number, and then digits at all. A flag that carried it would
    // move the data from a store that forgets into one that never does.
    expect(flags[0].snippet).not.toContain(NUMBER);
    expect(flags[0].snippet).not.toMatch(/\d/);
    expect(flags[0].snippet).toContain("a phone number");

    socket.ws.close(CLOSE.NORMAL, "done");
  });

  it("keeps an email address and a social handle out too", async () => {
    const socket = await connect("grave-lemur");
    socket.send({ t: "send", body: "riya.sharma@vit.edu or @riya.sharma01" });
    await socket.next("ephemeral");

    const flags = await flagsFor("grave-lemur");
    expect(flags[0].snippet).not.toContain("riya.sharma");
    expect(flags[0].snippet).toContain("an email address");

    socket.ws.close(CLOSE.NORMAL, "done");
  });
});

describe("a blocked message that also carries a number", () => {
  it("keeps the abusive text for the moderator and redacts the value", async () => {
    // The block tier attaches text on purpose, so a moderator does not need a
    // report to see it. That is not a licence to carry the number into Neon
    // with it: the queue drains there and Neon is permanent.
    const socket = await connect("dour-shrike");
    socket.send({ t: "send", body: "bc quiet-ibex ring 9876543219 now" });
    await socket.next("error");

    const flags = await flagsFor("dour-shrike");
    expect(flags[0].tier).toBe("block");
    expect(flags[0].snippet).toContain("quiet-ibex");
    expect(flags[0].snippet).not.toMatch(/\d/);

    // And the same row as the console will actually receive it.
    const drained = await runInDurableObject(
      stub(),
      async (instance: RoomDurableObject) => instance.drainFlags(),
    );
    const mine = drained.filter((f) => f.pseudonym === "dour-shrike");
    expect(mine).toHaveLength(1);
    expect(mine[0].snippet).not.toMatch(/\d/);

    socket.ws.close(CLOSE.NORMAL, "done");
  });
});

describe("an ordinary message", () => {
  it("is still stored, still paged, and still carries a seq", async () => {
    const socket = await connect("plain-otter");
    const body = "does anyone have the lab manual for tomorrow";
    socket.send({ t: "send", body });

    const frame = (await socket.next("message")) as Extract<
      ServerFrame,
      { t: "message" }
    >;
    expect(frame.m.body).toBe(body);
    expect(typeof frame.m.seq).toBe("number");
    expect(await storedBody(body)).toBe(1);

    socket.ws.close(CLOSE.NORMAL, "done");
  });
});
