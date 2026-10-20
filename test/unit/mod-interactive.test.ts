import { describe, expect, it, vi } from "vitest";
import { CliError, type ModClient } from "../../scripts/mod-client";
import { runInteractive } from "../../scripts/mod-interactive";
import { page, prompts, report, reports } from "./mod-test-helpers";

describe("interactive moderation", () => {
  it("offers all operator workflows and exits without a request", async () => {
    const ui = prompts(["exit"]);
    const client = vi.fn<ModClient>();
    await runInteractive(client as ModClient, ui);
    expect(ui.select.mock.calls[0][1].map((option) => option.label)).toEqual([
      "Reports",
      "Accounts",
      "Audit",
      "Room status",
      "Close all rooms",
      "Open all rooms",
      "Exit",
    ]);
    expect(client).not.toHaveBeenCalled();
    expect(ui.outro).toHaveBeenCalledOnce();
  });

  it("cancels from the main menu without a request", async () => {
    const ui = prompts([Symbol("cancel")]);
    const client = vi.fn<ModClient>();
    await runInteractive(client as ModClient, ui);
    expect(client).not.toHaveBeenCalled();
    expect(ui.cancel).toHaveBeenCalledOnce();
  });

  it.each([false, Symbol("cancel")])(
    "defaults room mutations to deny: %s",
    async (confirmation) => {
      const ui = prompts(["close", "exit"], [confirmation], ["abuse flood"]);
      const client = vi.fn<ModClient>();
      await runInteractive(client as ModClient, ui);
      expect(ui.note).toHaveBeenCalledWith(
        "Target: close all rooms\nReason: abuse flood",
        "Review change",
      );
      expect(ui.confirm).toHaveBeenCalledExactlyOnceWith(
        "Apply this moderation action?",
        false,
      );
      expect(client).not.toHaveBeenCalled();
      expect(ui.success).not.toHaveBeenCalled();
    },
  );

  it("cancels a suspension reason without any mutation", async () => {
    const ui = prompts(
      ["accounts", "item:0", "suspend"],
      [],
      [Symbol("cancel")],
    );
    const client = vi
      .fn<ModClient>()
      .mockResolvedValue(
        page([
          { handle: "quiet-ibex", suspended: false, suspendedReason: null },
        ]),
      );
    await runInteractive(client as ModClient, ui);
    expect(client).toHaveBeenCalledExactlyOnceWith("accounts", { page: 0 });
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(ui.cancel).toHaveBeenCalledOnce();
  });

  it("inspects retained report evidence before a confirmed removal", async () => {
    const ui = prompts(["reports", "item:0", "delete", "back", "exit"], [true]);
    const client = vi.fn<ModClient>().mockImplementation(async (action) => {
      if (action === "reports") return reports() as never;
      return { intent: "delete_message", ok: true } as never;
    });
    await runInteractive(client as ModClient, ui);
    expect(ui.note.mock.calls[0][0]).toContain(report.snapshot);
    expect(ui.note.mock.calls[0][0]).toContain(`Reason: ${report.reason}`);
    expect(ui.note.mock.calls[1][0]).toContain(report.id);
    expect(ui.note.mock.calls[1][0]).toContain(report.messageId);
    expect(ui.note.mock.invocationCallOrder[0]).toBeLessThan(
      ui.confirm.mock.invocationCallOrder[0],
    );
    expect(client.mock.calls).toEqual([
      ["reports", { page: 0 }],
      ["delete_message", { reportId: report.id }],
      ["reports", { page: 0 }],
    ]);
    expect(ui.success).toHaveBeenCalledExactlyOnceWith(
      "Action recorded: delete_message",
    );
  });

  it("binds suspension from report evidence to its handle and report", async () => {
    const ui = prompts(
      ["reports", "item:0", "suspend", "back", "exit"],
      [true],
      ["continued abuse"],
    );
    const client = vi.fn<ModClient>().mockImplementation(async (action) => {
      if (action === "reports") return reports() as never;
      return { intent: "suspend", ok: true } as never;
    });
    await runInteractive(client as ModClient, ui);
    expect(client).toHaveBeenCalledWith("suspend", {
      handle: report.suspendHandle,
      reportId: report.id,
      reason: "continued abuse",
    });
    expect(ui.note).toHaveBeenCalledWith(
      expect.stringContaining("Reason: continued abuse"),
      "Review change",
    );
  });

  it("offers dismissal for open reports and leaves closed evidence read only", async () => {
    const ui = prompts(
      ["reports", "item:0", "dismiss", "back", "exit"],
      [true],
    );
    const client = vi.fn<ModClient>().mockImplementation(async (action) => {
      if (action === "reports") return reports() as never;
      return { intent: "dismiss_report", ok: true } as never;
    });
    await runInteractive(client as ModClient, ui);
    expect(client).toHaveBeenCalledWith("dismiss_report", {
      reportId: report.id,
    });
    const closedUi = prompts(["reports", "item:0", "back", "exit"]);
    const closedClient = vi
      .fn<ModClient>()
      .mockResolvedValue(reports([{ ...report, status: "dismissed" }]));
    await runInteractive(closedClient as ModClient, closedUi);
    expect(closedUi.info).toHaveBeenCalledWith(
      expect.stringContaining("report is closed"),
    );
    expect(closedUi.confirm).not.toHaveBeenCalled();
    expect(
      closedClient.mock.calls.every(([action]) => action === "reports"),
    ).toBe(true);
  });

  it.each([false, true])(
    "suspends or restores the selected account: suspended=%s",
    async (suspended) => {
      const action = suspended ? "restore" : "suspend";
      const ui = prompts(
        ["accounts", "item:0", action, "back", "exit"],
        [true],
        suspended ? [] : ["abuse"],
      );
      const client = vi
        .fn<ModClient>()
        .mockImplementation(async (requested) => {
          if (requested === "accounts")
            return page([
              {
                handle: "quiet-ibex",
                suspended,
                suspendedReason: suspended ? "prior abuse" : null,
              },
            ]) as never;
          return { intent: action, ok: true } as never;
        });
      await runInteractive(client as ModClient, ui);
      expect(client).toHaveBeenCalledWith(action, {
        handle: "quiet-ibex",
        ...(suspended ? {} : { reason: "abuse" }),
      });
      expect(ui.confirm).toHaveBeenCalledWith(
        "Apply this moderation action?",
        false,
      );
      expect(ui.note.mock.calls[0][0]).toContain("Status:");
    },
  );

  it("paginates reports in both directions and shows an empty queue", async () => {
    const ui = prompts(["reports", "next", "previous", "back", "exit"]);
    const client = vi.fn<ModClient>().mockImplementation(
      async (_action, body) =>
        ({
          ...reports([]),
          page: body?.page,
          hasMore: body?.page === 0,
        }) as never,
    );
    await runInteractive(client as ModClient, ui);
    expect(client.mock.calls).toEqual([
      ["reports", { page: 0 }],
      ["reports", { page: 1 }],
      ["reports", { page: 0 }],
    ]);
    expect(ui.info).toHaveBeenCalledWith("No reports on this page.");
    expect(ui.select.mock.calls[2][1]).toContainEqual({
      value: "previous",
      label: "Previous page",
    });
  });

  it.each(["accounts", "audit"] as const)(
    "paginates empty %s results",
    async (action) => {
      const ui = prompts([action, "next", "back", "exit"]);
      const client = vi.fn<ModClient>().mockImplementation(
        async (_action, body) =>
          ({
            ...page([], Number(body?.page)),
            hasMore: body?.page === 0,
          }) as never,
      );
      await runInteractive(client as ModClient, ui);
      expect(client.mock.calls).toEqual([
        [action, { page: 0 }],
        [action, { page: 1 }],
      ]);
      expect(ui.info).toHaveBeenCalledWith(
        action === "accounts"
          ? "No accounts on this page."
          : "No audit entries on this page.",
      );
    },
  );

  it("renders historical audit actor kinds and handle-based details", async () => {
    const ui = prompts(["audit", "back", "exit"]);
    const client = vi.fn<ModClient>().mockResolvedValue(
      page([
        {
          id: "audit-1",
          action: "suspend",
          actorHandle: "quiet-ibex",
          actorKind: "console",
          targetType: "member",
          targetId: "legacy-id",
          reportId: report.id,
          details: { handle: "calm-fox", reason: "abuse" },
          createdAt: report.createdAt,
        },
      ]),
    );
    await runInteractive(client as ModClient, ui);
    expect(ui.note.mock.calls[0][0]).toContain("quiet-ibex (console)");
    expect(ui.note.mock.calls[0][0]).toContain("Handle: calm-fox");
    expect(ui.note.mock.calls[0][0]).toContain("Reason: abuse");
  });

  it("warns about an incomplete drain while stored reports remain inspectable", async () => {
    const ui = prompts(["reports", "item:0", "back", "back", "exit"]);
    const client = vi.fn<ModClient>().mockResolvedValue({
      ...reports(),
      drain: { complete: false, unreachableRooms: ["after-hours"] },
    });
    await runInteractive(client as ModClient, ui);
    expect(ui.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "automatic reports may still be pending in: after-hours",
      ),
    );
    expect(ui.note.mock.calls[0][0]).toContain(report.snapshot);
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("shows partial enforcement failure and returns to the menu without success", async () => {
    const ui = prompts(["open", "exit"], [true]);
    const client = vi.fn<ModClient>().mockRejectedValue(
      new CliError("One or more rooms could not be reached.", true, [
        { roomId: "campus-live", reachable: true },
        { roomId: "after-hours", reachable: false },
      ]),
    );
    await runInteractive(client as ModClient, ui);
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining("No rollback was performed"),
    );
    expect(ui.error).toHaveBeenCalledWith(
      expect.stringContaining("after-hours: unreachable"),
    );
    expect(ui.success).not.toHaveBeenCalled();
    expect(ui.outro).toHaveBeenCalledOnce();
  });

  it("preserves successful room reads while showing an unreachable room", async () => {
    const ui = prompts(["status", "exit"]);
    const client = vi.fn<ModClient>().mockResolvedValue({
      rooms: [
        {
          roomId: "campus-live",
          reachable: true,
          online: 4,
          messages: 2,
          killed: false,
          killedAt: null,
          killedBy: null,
        },
        { roomId: "after-hours", reachable: false },
      ],
      aggregate: null,
    });
    await runInteractive(client as ModClient, ui);
    expect(ui.note.mock.calls[0][0]).toContain("4 online; 2 messages");
    expect(ui.note.mock.calls[0][0]).toContain("after-hours: unreachable");
    expect(ui.note.mock.calls[0][0]).toContain("Aggregate unavailable");
  });

  it("shows safe read errors and allows a subsequent menu choice", async () => {
    const ui = prompts(["reports", "exit"]);
    const client = vi
      .fn<ModClient>()
      .mockRejectedValue(new Error("secret raw URL"));
    await runInteractive(client as ModClient, ui);
    expect(ui.error).toHaveBeenCalledExactlyOnceWith(
      "Moderation could not be completed.",
    );
    expect(ui.outro).toHaveBeenCalledOnce();
    expect(ui.load).toHaveBeenCalledWith(
      expect.stringContaining("Reading retained reports"),
      expect.any(Function),
    );
  });
});
