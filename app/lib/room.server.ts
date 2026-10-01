import type { RoomDurableObject } from "../../workers/room-do";

/**
 * Access to the room's Durable Object from app server code.
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

export async function getRoom(roomId: string): Promise<DurableObjectStub<RoomDurableObject>> {
  const namespace = await getNamespace();
  if (!namespace) throw new RoomUnreachable();
  return namespace.get(namespace.idFromName(roomId));
}

let namespacePromise:
  Promise<DurableObjectNamespace<RoomDurableObject> | undefined> | undefined;

function getNamespace() {
  return (namespacePromise ??= import("cloudflare:workers")
    .then((m) => (m.env as unknown as Env | undefined)?.ROOM)
    .catch(() => undefined));
}

/**
 * The console's live numbers are Durable Object reads, so they degrade to null
 * when the object is unreachable rather than taking the report queue down with
 * them.
 */
export async function tryRoom<T>(
  roomId: string,
  fn: (room: DurableObjectStub<RoomDurableObject>) => Promise<T>,
) {
  try {
    return await fn(await getRoom(roomId));
  } catch (error) {
    console.error("[room] unreachable:", error);
    return null;
  }
}
