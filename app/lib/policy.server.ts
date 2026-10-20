import { findMemberByPseudonym } from "~/db/queries/members";
import { materializePolicyFlag } from "~/db/queries/policy-flags";
import { tryRoom } from "~/lib/room.server";
import { ROOM_IDS, type RoomId } from "~/lib/rooms";
import { redactPersonal } from "../../workers/policy";

export interface DrainResult {
  drained: number;
  created: number;
  suspended: number;
  unreachable: boolean;
  unreachableRooms: string[];
}

const EMPTY: DrainResult = {
  drained: 0,
  created: 0,
  suspended: 0,
  unreachable: false,
  unreachableRooms: [],
};

function reason(matches: string, targeted: boolean): string {
  const aim = targeted ? " aimed at someone named in it" : "";
  return `Blocked automatically: ${matches}${aim}.`;
}

export async function drainPolicyFlags(): Promise<DrainResult> {
  const results = await Promise.all(
    ROOM_IDS.map(async (roomId) => {
      try {
        return await drainRoom(roomId);
      } catch {
        return { ...EMPTY, unreachable: true, unreachableRooms: [roomId] };
      }
    }),
  );
  return results.reduce(
    (sum, next) => ({
      drained: sum.drained + next.drained,
      created: sum.created + next.created,
      suspended: sum.suspended + next.suspended,
      unreachable: sum.unreachable || next.unreachable,
      unreachableRooms: [...sum.unreachableRooms, ...next.unreachableRooms],
    }),
    EMPTY,
  );
}

async function drainRoom(room: RoomId): Promise<DrainResult> {
  const flags = await tryRoom(room, (stub) => stub.drainFlags());
  if (!flags) return { ...EMPTY, unreachable: true, unreachableRooms: [room] };
  if (flags.length === 0) return EMPTY;

  const result: DrainResult = { ...EMPTY, drained: flags.length };
  let through = 0;

  for (const flag of flags) {
    const member = await findMemberByPseudonym(flag.pseudonym);
    if (!member) {
      through = flag.id;
      continue;
    }

    const created = await materializePolicyFlag({
      roomId: room,
      flagId: flag.id,
      reportedMemberId: member.id,
      pseudonym: flag.pseudonym,
      snippet: redactPersonal(flag.snippet),
      reason: reason(flag.matches, flag.targeted),
      autoSuspended: flag.autoSuspended,
    });
    if (created) {
      result.created += 1;
      if (flag.autoSuspended) result.suspended += 1;
    }
    through = flag.id;
  }

  if (through > 0) {
    const acknowledged = await tryRoom(room, async (stub) => {
      await stub.ackFlags(through);
      return true;
    });
    if (!acknowledged) {
      result.unreachable = true;
      result.unreachableRooms = [room];
    }
  }
  return result;
}
