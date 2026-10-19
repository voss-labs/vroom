import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { FlagRow } from "../../workers/policy-store";

const drainFlags = vi.fn();
const ackFlags = vi.fn();
const findMemberByPseudonym = vi.fn();
const materializePolicyFlag = vi.fn();
let activeRooms: Set<string>;

vi.mock("~/lib/room.server", () => ({
  tryRoom: async (id: string, fn: (stub: unknown) => unknown) => {
    if (!activeRooms.has(id)) return [];
    try {
      return await fn({ drainFlags: () => drainFlags(id), ackFlags });
    } catch {
      return null;
    }
  },
}));
vi.mock("~/db/queries/members", () => ({
  findMemberByPseudonym: (...args: unknown[]) => findMemberByPseudonym(...args),
}));
vi.mock("~/db/queries/policy-flags", () => ({
  materializePolicyFlag: (...args: unknown[]) => materializePolicyFlag(...args),
}));

const { drainPolicyFlags } = await import("~/lib/policy.server");

function flag(overrides: Partial<FlagRow> = {}): FlagRow {
  return {
    id: 7,
    pseudonym: "quiet-ibex",
    tier: "block",
    matches: "abuse, a handle",
    snippet: "bc swift-heron is at it again",
    targeted: true,
    confirmed: false,
    autoSuspended: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

function materializeOnce() {
  const seen = new Set<string>();
  materializePolicyFlag.mockImplementation(
    async (input: { roomId: string; flagId: number }) => {
      const key = `${input.roomId}:${input.flagId}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return { id: `report-${key}` };
    },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  activeRooms = new Set(["campus-live"]);
  findMemberByPseudonym.mockResolvedValue({ id: "member-1" });
  drainFlags.mockResolvedValue([]);
  materializeOnce();
});

describe("atomic policy materialization boundary", () => {
  it("passes the report and optional mirror as one operation before acknowledging", async () => {
    const order: string[] = [];
    drainFlags.mockResolvedValue([flag({ autoSuspended: true })]);
    materializePolicyFlag.mockImplementationOnce(async () => {
      order.push("materialize");
      return { id: "r7" };
    });
    ackFlags.mockImplementationOnce(async () => {
      order.push("ack");
    });
    expect(await drainPolicyFlags()).toMatchObject({
      drained: 1,
      created: 1,
      suspended: 1,
      unreachable: false,
    });
    expect(materializePolicyFlag).toHaveBeenCalledWith({
      roomId: "campus-live",
      flagId: 7,
      reportedMemberId: "member-1",
      pseudonym: "quiet-ibex",
      snippet: "bc swift-heron is at it again",
      reason:
        "Blocked automatically: abuse, a handle aimed at someone named in it.",
      autoSuspended: true,
    });
    expect(order).toEqual(["materialize", "ack"]);
    expect(ackFlags).toHaveBeenCalledWith(7);
  });

  it("waits for all Neon effects to commit before advancing acknowledgement", async () => {
    let release!: () => void;
    materializePolicyFlag.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ id: "r7" });
        }),
    );
    drainFlags.mockResolvedValue([flag({ autoSuspended: true })]);
    const pending = drainPolicyFlags();
    await vi.waitFor(() =>
      expect(materializePolicyFlag).toHaveBeenCalledOnce(),
    );
    expect(ackFlags).not.toHaveBeenCalled();
    release();
    expect((await pending).unreachable).toBe(false);
    expect(ackFlags).toHaveBeenCalledWith(7);
  });

  it("does not turn a completed flag into another report or suspension", async () => {
    drainFlags.mockResolvedValue([flag({ autoSuspended: true })]);
    expect(await drainPolicyFlags()).toMatchObject({
      created: 1,
      suspended: 1,
    });
    expect(await drainPolicyFlags()).toMatchObject({
      created: 0,
      suspended: 0,
      unreachable: false,
    });
    expect(materializePolicyFlag).toHaveBeenCalledTimes(2);
  });

  it("keeps ordinary blocked reports free of suspension mirroring", async () => {
    drainFlags.mockResolvedValue([flag()]);
    expect(await drainPolicyFlags()).toMatchObject({
      created: 1,
      suspended: 0,
    });
    expect(materializePolicyFlag).toHaveBeenCalledWith(
      expect.objectContaining({ autoSuspended: false }),
    );
  });

  it("redacts personal values again at the Neon boundary", async () => {
    drainFlags.mockResolvedValue([
      flag({ snippet: "bc quiet-ibex ring 9876543210 tonight" }),
    ]);
    await drainPolicyFlags();
    const input = materializePolicyFlag.mock.calls[0][0] as {
      snippet: string;
      reason: string;
    };
    expect(input.snippet).not.toMatch(/\d/);
    expect(input.snippet).toContain("a phone number");
    expect(input.reason).not.toMatch(/\d/);
  });
});

describe("drain failures and retries", () => {
  it("leaves failed atomic materialization unacknowledged and retries it", async () => {
    drainFlags.mockResolvedValue([flag({ autoSuspended: true })]);
    materializePolicyFlag.mockRejectedValueOnce(
      new Error("atomic database operation failed"),
    );
    expect(await drainPolicyFlags()).toMatchObject({
      unreachable: true,
      unreachableRooms: ["campus-live"],
    });
    expect(ackFlags).not.toHaveBeenCalled();
    expect(await drainPolicyFlags()).toMatchObject({
      created: 1,
      suspended: 1,
      unreachable: false,
    });
    expect(ackFlags).toHaveBeenCalledWith(7);
  });

  it("does not reapply completed work after acknowledgement fails", async () => {
    drainFlags.mockResolvedValue([flag({ autoSuspended: true })]);
    ackFlags.mockRejectedValueOnce(new Error("room unavailable"));
    expect(await drainPolicyFlags()).toMatchObject({
      created: 1,
      suspended: 1,
      unreachable: true,
    });
    expect(await drainPolicyFlags()).toMatchObject({
      created: 0,
      suspended: 0,
      unreachable: false,
    });
    expect(ackFlags).toHaveBeenCalledTimes(2);
  });

  it("keeps a pending overlapping drain from acknowledging before materialization", async () => {
    const releases: Array<(value: { id: string } | null) => void> = [];
    materializePolicyFlag.mockImplementation(
      () =>
        new Promise((resolve) => {
          releases.push(resolve);
        }),
    );
    drainFlags.mockResolvedValue([flag({ autoSuspended: true })]);
    const pending = [drainPolicyFlags(), drainPolicyFlags()];
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(ackFlags).not.toHaveBeenCalled();
    releases[0]({ id: "r7" });
    releases[1](null);
    const results = await Promise.all(pending);
    expect(results.reduce((sum, result) => sum + result.created, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.suspended, 0)).toBe(1);
    expect(results.every((result) => !result.unreachable)).toBe(true);
  });

  it("drains reachable rooms even if another room's database operation fails", async () => {
    activeRooms.add("hostel");
    drainFlags.mockResolvedValue([flag()]);
    materializePolicyFlag.mockImplementation(
      async (input: { roomId: string }) => {
        if (input.roomId === "hostel") throw new Error("database unavailable");
        return { id: "campus-report" };
      },
    );
    expect(await drainPolicyFlags()).toMatchObject({
      created: 1,
      unreachable: true,
      unreachableRooms: ["hostel"],
    });
    expect(ackFlags).toHaveBeenCalledOnce();
  });

  it("acknowledges a handle without a retained member record", async () => {
    findMemberByPseudonym.mockResolvedValue(null);
    drainFlags.mockResolvedValue([flag()]);
    expect((await drainPolicyFlags()).created).toBe(0);
    expect(materializePolicyFlag).not.toHaveBeenCalled();
    expect(ackFlags).toHaveBeenCalledWith(7);
  });

  it("reports an unreachable room without creating a report", async () => {
    drainFlags.mockRejectedValue(new Error("no object"));
    expect(await drainPolicyFlags()).toMatchObject({
      unreachable: true,
      created: 0,
      unreachableRooms: ["campus-live"],
    });
    expect(materializePolicyFlag).not.toHaveBeenCalled();
  });

  it("returns an explicit empty drain without acknowledgement", async () => {
    expect(await drainPolicyFlags()).toEqual({
      drained: 0,
      created: 0,
      suspended: 0,
      unreachable: false,
      unreachableRooms: [],
    });
    expect(ackFlags).not.toHaveBeenCalled();
  });
});
const WORKERS = fileURLToPath(new URL("../../workers", import.meta.url));

/** Every module the Durable Object pulls in, transitively, keyed by filename. */
function graphFrom(entry: string): Map<string, string[]> {
  const seen = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    const source = readFileSync(`${WORKERS}/${file}`, "utf-8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (m) => m[1],
    );
    seen.set(file, specifiers);
    for (const specifier of specifiers) {
      if (specifier.startsWith("./")) queue.push(`${specifier.slice(2)}.ts`);
    }
  }
  return seen;
}

describe("the room object's module graph", () => {
  it("imports nothing that could resolve a pseudonym to a person", () => {
    // VRIP-04's containment property is structural, not a convention. Anything
    // reaching Neon from in here could answer "who is this handle", and the
    // whole identity model rests on the object being unable to. The graph is
    // walked from room-do.ts rather than over the directory, because app.ts is
    // the Worker entry and is allowed everything the object is not.
    const graph = graphFrom("room-do.ts");

    // The walk must actually have traversed, or this passes by finding nothing.
    expect([...graph.keys()]).toEqual(
      expect.arrayContaining([
        "room-do.ts",
        "room-frames.ts",
        "room-sql.ts",
        "policy-store.ts",
        "policy.ts",
        "policy-patterns.ts",
        "policy-words.ts",
        "handles.ts",
      ]),
    );

    // A leaf like env.ts legitimately imports nothing, so vacuity is ruled out
    // by the graph's total edge count rather than per file.
    const edges = [...graph.values()].flat();
    expect(edges.length).toBeGreaterThan(10);

    for (const [file, specifiers] of graph) {
      for (const specifier of specifiers) {
        const local = specifier.startsWith("./") && !specifier.includes("..");
        expect(
          local || specifier === "cloudflare:workers",
          `${file} imports ${specifier}`,
        ).toBe(true);
      }
    }
  });
});
