import { describe, it, expect, vi, beforeEach } from "vitest";

import type { MemberRecord } from "~/db/queries/members";

/**
 * The console route, driven through its real loader and action.
 *
 * Nothing tested `mod.tsx` before, and the role check was only ever exercised as
 * `assertModerator` against a hand-built record — which cannot show you that the
 * guard reads a field the real read path does not enforce. Suspension revoking
 * the console is the property that hid there, so it is asserted here at the
 * route, not at the helper.
 */

const getSessionUser = vi.fn();
const ensureMember = vi.fn();
const listReports = vi.fn();
const countReports = vi.fn();
const countOpenReports = vi.fn();
const setKilled = vi.fn();
const roomSuspend = vi.fn();
const roomRestore = vi.fn();
const resolveIdentity = vi.fn();
const writeAudit = vi.fn();
const findReport = vi.fn();
const findMemberById = vi.fn();

vi.mock("~/lib/auth.server", () => ({
  getSessionUser: (...a: unknown[]) => getSessionUser(...a),
}));
vi.mock("~/db/queries/members", () => ({
  ensureMember: (...a: unknown[]) => ensureMember(...a),
  findMemberById: (...a: unknown[]) => findMemberById(...a),
  findMemberByPseudonym: vi.fn(),
  claimPseudonym: vi.fn(),
  setSuspended: vi.fn(async () => null),
  countSuspended: vi.fn(async () => 0),
  listAccounts: vi.fn(async () => []),
}));
vi.mock("~/db/queries/reports", () => ({
  REPORTS_PAGE_SIZE: 50,
  listReports: (...a: unknown[]) => listReports(...a),
  countReports: (...a: unknown[]) => countReports(...a),
  countOpenReports: (...a: unknown[]) => countOpenReports(...a),
  findReport: (...a: unknown[]) => findReport(...a),
  setReportStatus: vi.fn(async () => true),
}));
vi.mock("~/db/queries/audit", () => ({
  listAudit: vi.fn(async () => []),
  writeAudit: (...a: unknown[]) => writeAudit(...a),
}));
vi.mock("~/lib/identity.server", () => ({
  resolveIdentity: (...a: unknown[]) => resolveIdentity(...a),
}));
vi.mock("~/lib/room.server", () => ({
  RoomUnreachable: class RoomUnreachable extends Error {},
  getRoom: async () => ({
    setKilled: (...a: unknown[]) => setKilled(...a),
    suspend: (...a: unknown[]) => roomSuspend(...a),
    restore: (...a: unknown[]) => roomRestore(...a),
    deleteMessage: vi.fn(async () => ({ ok: true })),
  }),
  tryRoom: async () => null,
  readRooms: async () => null,
}));

const { loader, action } = await import("~/routes/mod");
const { ROOM_IDS } = await import("~/lib/rooms");

type LoaderArgs = Parameters<typeof loader>[0];
type ActionArgs = Parameters<typeof action>[0];

function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: "m1",
    userId: "u1",
    pseudonym: "quiet-ibex",
    isModerator: true,
    suspendedAt: null,
    suspendedReason: null,
    deletedAt: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function get(url = "https://v-rooms.test/mod"): LoaderArgs {
  return {
    request: new Request(url),
    params: {},
    context: {},
  } as unknown as LoaderArgs;
}

function post(
  fields: Record<string, string>,
  headers: Record<string, string> = {},
): ActionArgs {
  const body = new URLSearchParams(fields);
  return {
    request: new Request("https://v-rooms.test/mod", {
      method: "POST",
      body,
      headers: { "sec-fetch-site": "same-origin", ...headers },
    }),
    params: {},
    context: {},
  } as unknown as ActionArgs;
}

/** Every intent the console can submit, with the fields each one needs. */
const INTENTS: Array<Record<string, string>> = [
  { intent: "set_room_state", killed: "true" },
  { intent: "restore", memberId: "m1" },
  { intent: "reveal", reportId: "r1" },
  { intent: "suspend", memberId: "m2" },
  { intent: "delete_message", reportId: "r1" },
  { intent: "dismiss_report", reportId: "r1" },
];

beforeEach(() => {
  vi.clearAllMocks();
  getSessionUser.mockResolvedValue({ id: "u1" });
  ensureMember.mockResolvedValue(member());
  listReports.mockResolvedValue([]);
  countReports.mockResolvedValue(0);
  countOpenReports.mockResolvedValue(0);
  findReport.mockResolvedValue({
    id: "r1",
    messageId: "msg1",
    snapshot: "text",
    reason: null,
    handle: "grumpy-heron",
    reportedMemberId: "m2",
    status: "open",
    createdAt: new Date(),
  });
  findMemberById.mockResolvedValue(
    member({ id: "m2", pseudonym: "grumpy-heron" }),
  );
  setKilled.mockResolvedValue({ killed: true, at: 1 });
  resolveIdentity.mockResolvedValue({
    email: "x@vit.edu.in",
    name: "X",
    auditId: "a1",
  });
  writeAudit.mockResolvedValue({ id: "a1" });
});

describe("a signed-out visitor", () => {
  beforeEach(() => {
    getSessionUser.mockResolvedValue(null);
  });

  it("is sent home and the queue is never read", async () => {
    await expect(loader(get())).rejects.toMatchObject({ status: 302 });
    expect(listReports).not.toHaveBeenCalled();
  });

  it("cannot post a moderation action", async () => {
    await expect(
      action(post({ intent: "set_room_state", killed: "true" })),
    ).rejects.toMatchObject({ status: 302 });
    expect(setKilled).not.toHaveBeenCalled();
  });
});

describe("a suspended moderator", () => {
  beforeEach(() => {
    ensureMember.mockResolvedValue(member({ suspendedAt: new Date() }));
  });

  it("cannot open the console", async () => {
    await expect(loader(get())).rejects.toMatchObject({ status: 404 });
    expect(listReports).not.toHaveBeenCalled();
  });

  it("cannot reach the kill switch, restore, reveal, or any other intent", async () => {
    for (const fields of INTENTS) {
      await expect(action(post(fields))).rejects.toMatchObject({ status: 404 });
    }
    // Nothing was enforced and nothing was recorded, for any of the six.
    expect(setKilled).not.toHaveBeenCalled();
    expect(roomRestore).not.toHaveBeenCalled();
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(roomSuspend).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("cannot restore itself", async () => {
    await expect(
      action(post({ intent: "restore", memberId: "m1" })),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(roomRestore).not.toHaveBeenCalled();
  });
});

describe("a tombstoned moderator", () => {
  it("is refused the console through the same guard", async () => {
    ensureMember.mockResolvedValue(member({ deletedAt: new Date() }));
    await expect(loader(get())).rejects.toMatchObject({ status: 404 });
    await expect(
      action(post({ intent: "set_room_state", killed: "true" })),
    ).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("a student", () => {
  it("gets 404 rather than 403, so the console stays unadvertised", async () => {
    ensureMember.mockResolvedValue(member({ isModerator: false }));
    await expect(loader(get())).rejects.toMatchObject({ status: 404 });
  });
});

describe("cross-origin", () => {
  it("refuses a post that announces itself as cross-site", async () => {
    const result = await action(
      post(
        { intent: "set_room_state", killed: "true" },
        {
          "sec-fetch-site": "cross-site",
        },
      ),
    );
    expect(result.data.error?.code).toBe("cross_origin");
    expect(result.init?.status).toBe(403);
    expect(setKilled).not.toHaveBeenCalled();
  });

  it("refuses a post carrying a foreign Origin and no fetch metadata", async () => {
    const request = new Request("https://v-rooms.test/mod", {
      method: "POST",
      body: new URLSearchParams({ intent: "set_room_state", killed: "true" }),
      headers: { origin: "https://attacker.example" },
    });
    const result = await action({
      request,
      params: {},
      context: {},
    } as unknown as ActionArgs);
    expect(result.data.error?.code).toBe("cross_origin");
    expect(setKilled).not.toHaveBeenCalled();
  });

  it("refuses a bare post that proves nothing about where it came from", async () => {
    const request = new Request("https://v-rooms.test/mod", {
      method: "POST",
      body: new URLSearchParams({ intent: "set_room_state", killed: "true" }),
    });
    const result = await action({
      request,
      params: {},
      context: {},
    } as unknown as ActionArgs);
    expect(result.data.error?.code).toBe("cross_origin");
  });

  it("is checked before the role, so it cannot be probed for who is a moderator", async () => {
    ensureMember.mockResolvedValue(member({ isModerator: false }));
    const result = await action(
      post(
        { intent: "set_room_state", killed: "true" },
        {
          "sec-fetch-site": "cross-site",
        },
      ),
    );
    // A student and a moderator get the same answer to a cross-origin post.
    expect(result.init?.status).toBe(403);
  });
});

describe("a moderator in good standing", () => {
  it("still closes the room, so the guard is not simply refusing everyone", async () => {
    const result = await action(
      post({ intent: "set_room_state", killed: "true" }),
    );
    expect(setKilled).toHaveBeenCalledTimes(ROOM_IDS.length);
    expect(result.data.data).toMatchObject({
      intent: "set_room_state",
      killed: true,
    });
  });

  it("records why the room was closed, which is the reason the row exists", async () => {
    await action(
      post({
        intent: "set_room_state",
        killed: "true",
        reason: "reports arriving fast",
      }),
    );
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "room_close",
        details: { reason: "reports arriving fast" },
      }),
    );
  });
});

describe("the queue the console renders", () => {
  it("asks for a page and reports the total, so truncation is visible", async () => {
    listReports.mockResolvedValue([]);
    countReports.mockResolvedValue(261);

    const result = await loader(get());
    expect(listReports).toHaveBeenCalledWith(0);
    expect(result.totalReports).toBe(261);
    expect(result.pageCount).toBe(6);
    expect(result.page).toBe(0);
  });

  it("serves the page the moderator asked for, so page two exists", async () => {
    countReports.mockResolvedValue(261);
    const result = await loader(get("https://v-rooms.test/mod?page=3"));
    expect(listReports).toHaveBeenCalledWith(3);
    expect(result.page).toBe(3);
  });

  it("ignores a junk page rather than emitting a nonsense query", async () => {
    await loader(get("https://v-rooms.test/mod?page=-4"));
    expect(listReports).toHaveBeenCalledWith(0);

    listReports.mockClear();
    await loader(get("https://v-rooms.test/mod?page=drop-table"));
    expect(listReports).toHaveBeenCalledWith(0);
  });
});
