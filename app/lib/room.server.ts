import type { RoomDurableObject, RoomStats } from "../../workers/room-do";
import type { RoomState } from "../../workers/room-sql";
import { ROOM_IDS, type RoomId } from "~/lib/rooms";

/**
 * Access to the room Durable Objects from app server code.
 *
 * The binding is the authorization boundary — there is no token between the
 * console and the object (VRIP-06). It is resolved through a lazy dynamic
 * import so every module importing this file stays loadable under plain Node,
 * where `cloudflare:workers` does not exist.
 */

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

/**
 * The console's live numbers are Durable Object reads, so they degrade to null
 * when the object is unreachable rather than taking the report queue down with
 * them.
 */
export async function tryRoom<T>(
  roomId: RoomId,
  fn: (room: RoomStub) => Promise<T>,
) {
  try {
    return await fn(await getRoom(roomId));
  } catch (error) {
    console.error(`[room] ${roomId} unreachable:`, error);
    return null;
  }
}

export interface RoomRead {
  stats: RoomStats;
  state: RoomState;
  counts: Record<string, number>;
}

export interface RoomPulse {
  roomId: RoomId;
  online: number;
  messages: number;
  killed: boolean;
}

export interface RoomsView {
  stats: RoomStats;
  roomState: RoomState;
  counts: Record<string, number>;
  perRoom?: RoomPulse[];
}

/** Lightweight per-room online and 48h message counts for room switchers and landing previews. */
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

/** One view across every room, or null if any room could not be read. */
export async function readRooms(): Promise<RoomsView | null> {
  const reads = await Promise.all(
    ROOM_IDS.map((id) =>
      tryRoom(id, async (room) => ({
        stats: await room.stats(),
        state: await room.getRoomState(),
        counts: await room.countsByPseudonym(),
      })),
    ),
  );
  const merged = mergeRoomReads(reads);
  if (!merged) return null;
  return {
    ...merged,
    perRoom: ROOM_IDS.map((roomId, idx) => ({
      roomId,
      online: reads[idx]!.stats.online,
      messages: reads[idx]!.stats.total,
      killed: reads[idx]!.state.killed,
    })),
  };
}

/**
 * A partial sum reads as a true number and is not one, so any unreachable room
 * makes the whole view null. A student in two rooms is counted once online;
 * peak today is the sum of per-room peaks, an upper bound rather than a reading.
 */
export function mergeRoomReads(
  reads: ReadonlyArray<RoomRead | null>,
): RoomsView | null {
  const rooms: RoomRead[] = [];
  for (const read of reads) {
    if (!read) return null;
    rooms.push(read);
  }

  const online = new Set<string>();
  const counts: Record<string, number> = {};
  let total = 0;
  let since: number | null = null;
  let peakToday = 0;
  let killedAt: number | null = null;
  let killedBy: string | null = null;

  for (const { stats, state, counts: perRoom } of rooms) {
    for (const handle of stats.members) online.add(handle);
    total += stats.total;
    if (stats.since !== null && (since === null || stats.since < since)) {
      since = stats.since;
    }
    peakToday += stats.peakToday;
    if (
      state.killedAt !== null &&
      (killedAt === null || state.killedAt > killedAt)
    ) {
      killedAt = state.killedAt;
      killedBy = state.killedBy;
    }
    for (const [handle, n] of Object.entries(perRoom)) {
      counts[handle] = (counts[handle] ?? 0) + n;
    }
  }

  const members = [...online].sort();
  return {
    stats: { total, since, peakToday, online: members.length, members },
    roomState: {
      killed: rooms.every((room) => room.state.killed),
      killedAt,
      killedBy,
    },
    counts,
  };
}
