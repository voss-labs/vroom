import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

import {
  CLOSE,
  MESSAGE_TTL_MS,
  type ServerFrame,
} from "../../workers/protocol";
import type { RoomDurableObject } from "../../workers/room-do";
import * as db from "../../workers/room-sql";
import { clear, open, token } from "./helpers";

const RETENTION_ROOM = "electives";

function stub() {
  return env.ROOM.get(env.ROOM.idFromName(RETENTION_ROOM));
}

async function connect(handle: string) {
  const { socket } = await open(
    await token(handle, 900, RETENTION_ROOM),
    RETENTION_ROOM,
  );
  if (!socket) throw new Error("upgrade failed");
  await socket.next("ready");
  return socket;
}

describe("48-hour disappearing messages", () => {
  it("hard-deletes expired messages from SQLite on alarm and reschedules for remaining messages", async () => {
    const now = Date.now();
    const expiredAt = now - MESSAGE_TTL_MS - 60_000;
    const freshAt = now - 10 * 60_000;

    await runInDurableObject(
      stub(),
      async (instance: RoomDurableObject, state) => {
        const sql = state.storage.sql;
        db.ensureSchema(sql);
        sql.exec("DELETE FROM messages");

        db.insertMessage(sql, {
          id: "msg-expired-1",
          pseudonym: "quiet-ibex",
          body: "older than 48 hours",
          createdAt: expiredAt,
        });
        db.insertMessage(sql, {
          id: "msg-fresh-1",
          pseudonym: "swift-heron",
          body: "within 48 hours",
          createdAt: freshAt,
        });

        await instance.alarm();

        const rows = sql
          .exec<{ id: string }>("SELECT id FROM messages ORDER BY seq ASC")
          .toArray();
        expect(rows.map((r) => r.id)).toEqual(["msg-fresh-1"]);

        const nextAlarm = await state.storage.getAlarm();
        expect(nextAlarm).toBe(freshAt + MESSAGE_TTL_MS);
      },
    );

    const expiredLookup = await stub().getMessage("msg-expired-1");
    expect(expiredLookup).toBeNull();

    const freshLookup = await stub().getMessage("msg-fresh-1");
    expect(freshLookup?.body).toBe("within 48 hours");
  });

  it("prunes expired messages on join, send, stats, and countsByPseudonym", async () => {
    const now = Date.now();
    const expiredAt = now - MESSAGE_TTL_MS - 1_000;

    await runInDurableObject(stub(), async (_instance, state) => {
      const sql = state.storage.sql;
      db.ensureSchema(sql);
      sql.exec("DELETE FROM messages");

      db.insertMessage(sql, {
        id: "msg-expired-join",
        pseudonym: "old-otter",
        body: "vanished",
        createdAt: expiredAt,
      });
    });

    const socket = await connect("keen-falcon");
    const ready = (await socket.next("ready")) as Extract<
      ServerFrame,
      { t: "ready" }
    >;
    expect(ready.messages.some((m) => m.id === "msg-expired-join")).toBe(false);

    clear(socket);
    socket.send({ t: "send", body: "live message" });
    const posted = (await socket.next("message")) as Extract<
      ServerFrame,
      { t: "message" }
    >;
    expect(posted.m.body).toBe("live message");

    const stats = await stub().stats();
    expect(stats.total).toBe(1);

    const counts = await stub().countsByPseudonym();
    expect(counts["old-otter"]).toBeUndefined();
    expect(counts["keen-falcon"]).toBe(1);

    socket.ws.close(CLOSE.NORMAL, "done");
  });
});
