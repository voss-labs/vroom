import { beforeEach, vi } from "vitest";
import type { ActionFunctionArgs } from "react-router";
import type { MemberRecord } from "~/db/queries/members";

const mocks = vi.hoisted(() => ({
  findMemberByPseudonym: vi.fn(),
  findMemberById: vi.fn(),
  listAccounts: vi.fn(),
  countAccounts: vi.fn(),
  listReports: vi.fn(),
  countReports: vi.fn(),
  findReport: vi.fn(),
  setReportStatus: vi.fn(),
  setSuspended: vi.fn(),
  listAudit: vi.fn(),
  countAudit: vi.fn(),
  writeAudit: vi.fn(),
  drainPolicyFlags: vi.fn(),
  readRoomStatus: vi.fn(),
  checkScriptAuth: vi.fn(),
  setKilled: vi.fn(),
  suspend: vi.fn(),
  restore: vi.fn(),
  deleteMessage: vi.fn(),
}));

vi.mock("~/db/queries/members", () => ({
  findMemberByPseudonym: mocks.findMemberByPseudonym,
  findMemberById: mocks.findMemberById,
  listAccounts: mocks.listAccounts,
  countAccounts: mocks.countAccounts,
  setSuspended: mocks.setSuspended,
  claimPseudonym: vi.fn(),
}));
vi.mock("~/db/queries/reports", () => ({
  listReports: mocks.listReports,
  countReports: mocks.countReports,
  findReport: mocks.findReport,
  setReportStatus: mocks.setReportStatus,
}));
vi.mock("~/db/queries/audit", () => ({
  listAudit: mocks.listAudit,
  countAudit: mocks.countAudit,
  writeAudit: mocks.writeAudit,
}));
vi.mock("~/lib/policy.server", () => ({
  drainPolicyFlags: mocks.drainPolicyFlags,
}));
vi.mock("~/lib/room.server", () => ({
  RoomUnreachable: class extends Error {},
  readRoomStatus: mocks.readRoomStatus,
  getRoom: async (roomId: string) => ({
    setKilled: (killed: boolean, by: string) =>
      mocks.setKilled(roomId, killed, by),
    suspend: mocks.suspend,
    restore: mocks.restore,
    deleteMessage: mocks.deleteMessage,
  }),
  tryRoom: async (_id: string, fn: (stub: unknown) => unknown) => {
    try {
      return await fn({ checkScriptAuth: mocks.checkScriptAuth });
    } catch {
      return null;
    }
  },
}));

const { action } = await import("~/routes/api.mod.$action");
const { ROOM_IDS } = await import("~/lib/rooms");
const { MOD_INTENTS } = await import("~/lib/moderation.server");
const ACTIONS = ["reports", "accounts", "audit", "status", ...MOD_INTENTS];
const DATE = new Date("2026-01-01T00:00:00Z");

function member(overrides: Partial<MemberRecord> = {}): MemberRecord {
  return {
    id: "actor",
    userId: "private-auth-user",
    pseudonym: "quiet-ibex",
    isModerator: true,
    suspendedAt: null,
    suspendedReason: null,
    deletedAt: null,
    createdAt: DATE,
    ...overrides,
  };
}

function call(
  intent: string,
  body: unknown = {},
  token: string | null = process.env.MOD_SCRIPT_TOKEN!,
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  return action({
    request: new Request(`https://vrooms.test/api/mod/${intent}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers,
    }),
    params: { action: intent },
    context: {},
  } as unknown as ActionFunctionArgs);
}

beforeEach(() => {
  vi.resetAllMocks();
  process.env.MOD_SCRIPT_TOKEN = "testing-script-credential";
  process.env.MOD_SCRIPT_MEMBER_HANDLE = "quiet-ibex";
  mocks.findMemberByPseudonym.mockResolvedValue(member());
  mocks.findMemberById.mockResolvedValue(member());
  mocks.checkScriptAuth.mockResolvedValue({ allowed: true, retryAfter: 0 });
  mocks.drainPolicyFlags.mockResolvedValue({
    unreachable: false,
    unreachableRooms: [],
  });
  mocks.listReports.mockResolvedValue([]);
  mocks.countReports.mockResolvedValue(0);
  mocks.listAccounts.mockResolvedValue([]);
  mocks.countAccounts.mockResolvedValue(0);
  mocks.listAudit.mockResolvedValue([]);
  mocks.countAudit.mockResolvedValue(0);
  mocks.readRoomStatus.mockResolvedValue({ rooms: [], aggregate: null });
  mocks.setKilled.mockResolvedValue({ killed: true, at: 123 });
  mocks.setReportStatus.mockResolvedValue(true);
  mocks.findReport.mockResolvedValue({
    id: "r1",
    roomId: "hostel",
    messageId: "expired",
    reportedMemberId: "target",
  });
});

export async function payload(response: Response): Promise<{
  data: Record<string, unknown> & { items: unknown[] };
  error: import("~/lib/moderation-contract").ModError;
}> {
  return (await response.json()) as {
    data: Record<string, unknown> & { items: unknown[] };
    error: import("~/lib/moderation-contract").ModError;
  };
}

export { mocks, call, member, DATE, ROOM_IDS, ACTIONS };
