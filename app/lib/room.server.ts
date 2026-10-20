import type { RoomDurableObject } from "../../workers/room-do";
import { ROOM_IDS, type RoomId } from "~/lib/rooms";
import type { StatusView, RoomStatus } from "~/lib/moderation-contract";
import { isValidHandle } from "~/lib/pseudonym";

export class RoomUnreachable extends Error {
  constructor(cause?: unknown) {
    super("The room is unreachable.");
    this.name = "RoomUnreachable";
    this.cause = cause;
  }
}

export type RoomStub = DurableObjectStub<RoomDurableObject>;

let namespacePromise:
  Promise<DurableObjectNamespace<RoomDurableObject> | undefined> | undefined;

function getNamespace() {
  return (namespacePromise ??= import("cloudflare:workers")
    .then((m) => (m.env as unknown as Env | undefined)?.ROOM)
    .catch(() => undefined));
}

export async function getRoom(roomId: RoomId): Promise<RoomStub> {
  const namespace = await getNamespace();
  if (!namespace) throw new RoomUnreachable();
  return namespace.get(namespace.idFromName(roomId));
}

export async function tryRoom<T>(
  roomId: RoomId,
  fn: (room: RoomStub) => Promise<T>,
) {
  try {
    return await fn(await getRoom(roomId));
  } catch {
    console.error(`[room] ${roomId} unreachable`);
    return null;
  }
}

export async function readRoomStatus(): Promise<StatusView> {
  const reads = await Promise.all(
    ROOM_IDS.map((roomId) =>
      tryRoom(roomId, async (room) => {
        const [stats, state] = await Promise.all([
          room.stats(),
          room.getRoomState(),
        ]);
        return { stats, state };
      }),
    ),
  );
  const rooms: RoomStatus[] = reads.map((read, index) => {
    const roomId = ROOM_IDS[index];
    if (!read) return { roomId, reachable: false };
    return {
      roomId,
      reachable: true,
      online: read.stats.online,
      messages: read.stats.total,
      killed: read.state.killed,
      killedAt: read.state.killedAt,
      killedBy:
        read.state.killedBy && isValidHandle(read.state.killedBy)
          ? read.state.killedBy
          : null,
    };
  });
  if (reads.some((read) => read === null)) return { rooms, aggregate: null };
  const online = new Set(reads.flatMap((read) => read!.stats.members));
  return {
    rooms,
    aggregate: {
      online: online.size,
      messages: reads.reduce((sum, read) => sum + read!.stats.total, 0),
      killed: reads.every((read) => read!.state.killed),
    },
  };
}

export interface RoomPulse {
  roomId: RoomId;
  online: number;
  messages: number;
  killed: boolean;
}

export async function readRoomPulses(): Promise<Record<
  RoomId,
  RoomPulse
> | null> {
  const reads = await Promise.all(
    ROOM_IDS.map(async (roomId) => {
      const res = await tryRoom(roomId, async (room) => ({
        stats: await room.stats(),
        state: await room.getRoomState(),
      }));
      if (!res) return null;
      return {
        roomId,
        online: res.stats.online,
        messages: res.stats.total,
        killed: res.state.killed,
      } satisfies RoomPulse;
    }),
  );
  const out = {} as Record<RoomId, RoomPulse>;
  for (const item of reads) {
    if (!item) return null;
    out[item.roomId] = item;
  }
  return out;
}
