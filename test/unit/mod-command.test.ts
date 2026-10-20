import { describe, expect, it, vi } from "vitest";
import { parseCommand, type RequestCommand } from "../../scripts/mod-input";
import { runCommand } from "../../scripts/mod-command";
import {
  auditText,
  display,
  reportText,
  statusText,
} from "../../scripts/mod-display";
import type { ModClient } from "../../scripts/mod-client";

const reportId = "10000000-0000-4000-8000-000000000001";

describe("moderation commands", () => {
  it.each([
    {
      action: "restore",
      actorKind: "script",
      actorHandle: null,
      actorSessionId: reportId,
      label: `CLI session ${reportId} (script)`,
    },
    {
      action: "restore",
      actorKind: "script",
      actorHandle: "quiet-ibex",
      actorSessionId: null,
      label: "quiet-ibex (script)",
    },
    {
      action: "suspend",
      actorKind: "console",
      actorHandle: "quiet-ibex",
      actorSessionId: null,
      label: "quiet-ibex (console)",
    },
    {
      action: "auto_suspend",
      actorKind: "script",
      actorHandle: null,
      actorSessionId: null,
      label: "system (script)",
    },
    {
      action: "auto_suspend",
      actorKind: "script",
      actorHandle: null,
      actorSessionId: reportId,
      label: "system (script)",
    },
  ])("keeps $action actor attribution as $label", ({ label, ...actor }) => {
    const text = auditText({
      id: "audit-1",
      ...actor,
      targetType: "member",
      targetId: "member-1",
      reportId: null,
      details: null,
      createdAt: "2040-01-01T00:00:00.000Z",
    });
    expect(text).toContain(`Actor: ${label}`);
    if (actor.action === "auto_suspend")
      expect(text).not.toContain("CLI session");
  });
  it("enters the same interactive mode with no arguments", () => {
    expect(parseCommand([])).toEqual({ kind: "interactive" });
    expect(parseCommand(["--help"])).toMatchObject({
      kind: "help",
      text: expect.stringContaining("npm run manage"),
    });
  });

  it.each([
    [
      ["close", "emergency"],
      "set_room_state",
      { killed: true, reason: "emergency" },
    ],
    [["open"], "set_room_state", { killed: false }],
    [
      ["suspend", "quiet-ibex", "harassment"],
      "suspend",
      { handle: "quiet-ibex", reason: "harassment" },
    ],
    [["restore", "quiet-ibex-0001"], "restore", { handle: "quiet-ibex-0001" }],
    [["delete", reportId], "delete_message", { reportId }],
    [["dismiss", reportId], "dismiss_report", { reportId }],
    [["reports"], "reports", { page: 0 }],
    [["accounts", "2"], "accounts", { page: 2 }],
    [["audit", "9999"], "audit", { page: 9999 }],
    [["status"], "status", {}],
  ] as const)("parses %j", (args, action, body) => {
    expect(parseCommand([...args])).toEqual({ kind: "request", action, body });
  });

  it.each(
    [
      ["unknown"],
      ["open", "unexpected"],
      ["close", "a", "b"],
      ["suspend"],
      ["suspend", "email@example.test"],
      ["restore", "quiet-ibex", "x"],
      ["delete"],
      ["dismiss", "not-a-uuid"],
      ["reports", "-1"],
      ["accounts", "0.5"],
      ["audit", "10000"],
      ["reports", "NaN"],
      ["audit", "01"],
      ["status", "0"],
      ["close", "bad\u001b[2J"],
      ["suspend", "quiet-ibex", "x".repeat(1001)],
    ].map((args) => ({ args })),
  )("rejects invalid arguments $args before transport", ({ args }) => {
    expect(() => parseCommand(args)).toThrow();
  });

  it("keeps explicit mutations scriptable without prompting", async () => {
    const client = vi
      .fn<ModClient>()
      .mockResolvedValue({ intent: "restore", ok: true });
    const output = vi.fn();
    await runCommand(
      parseCommand(["restore", "quiet-ibex"]) as RequestCommand,
      client as ModClient,
      output,
      vi.fn(),
    );
    expect(client).toHaveBeenCalledExactlyOnceWith("restore", {
      handle: "quiet-ibex",
    });
    expect(JSON.parse(output.mock.calls[0][0])).toEqual({
      intent: "restore",
      ok: true,
    });
  });

  it("prints paginated stored reports and warns when the drain is incomplete", async () => {
    const reports = {
      items: [],
      page: 2,
      pageSize: 25,
      total: 50,
      hasMore: false,
      drain: { complete: false, unreachableRooms: ["after-hours"] },
    };
    const client = vi.fn<ModClient>().mockResolvedValue(reports);
    const output = vi.fn();
    const warn = vi.fn();
    await runCommand(
      parseCommand(["reports", "2"]) as RequestCommand,
      client as ModClient,
      output,
      warn,
    );
    expect(client).toHaveBeenCalledExactlyOnceWith("reports", { page: 2 });
    expect(JSON.parse(output.mock.calls[0][0])).toEqual(reports);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Policy drain incomplete"),
    );
  });

  it("shows successful room state alongside an outage and omits aggregate totals", () => {
    const text = statusText({
      rooms: [
        {
          roomId: "campus-live",
          reachable: true,
          online: 3,
          messages: 8,
          killed: true,
          killedAt: 0,
          killedBy: "quiet-ibex",
        },
        { roomId: "after-hours", reachable: false },
      ],
      aggregate: null,
    });
    expect(text).toContain("campus-live: reachable; closed");
    expect(text).toContain("3 online; 8 messages");
    expect(text).toContain("after-hours: unreachable; current state unknown");
    expect(text).toContain("Aggregate unavailable");
  });

  it("neutralizes terminal control sequences in retained evidence and reasons", () => {
    const hostile =
      "before\u001b[2J\u001b]52;c;Y2xpcGJvYXJk\u0007after\u0008\u202e";
    expect(display(hostile)).toBe("beforeafter");
    const text = reportText({
      id: reportId,
      messageId: "expired-message",
      handle: "quiet-ibex",
      suspendHandle: "quiet-ibex",
      roomId: "campus-live",
      status: "open",
      reason: hostile,
      snapshot: hostile,
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    expect(text).toContain("Message: expired-message");
    expect(text).toContain("Reason: beforeafter");
    expect(text).toContain("Retained message snapshot:\nbeforeafter");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("Y2xpcGJvYXJk");
  });
});
