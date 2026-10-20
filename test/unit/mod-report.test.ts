import { describe, expect, it, vi } from "vitest";
import type { ModClient } from "../../scripts/mod-client";
import { runInteractive } from "../../scripts/mod-interactive";
import { prompts, report, reports } from "./mod-test-helpers";

describe("report author evidence and suspension targets", () => {
  it.each(["delete", "dismiss"] as const)(
    "keeps memberless Local Dev evidence readable and allows %s without suspension",
    async (action) => {
      const legacy = { ...report, handle: "Local Dev", suspendHandle: null };
      const intent = action === "delete" ? "delete_message" : "dismiss_report";
      const ui = prompts(["reports", "item:0", action, "back", "exit"], [true]);
      const client = vi
        .fn<ModClient>()
        .mockImplementation(async (requested) => {
          if (requested === "reports") return reports([legacy]) as never;
          return { intent, ok: true } as never;
        });

      await runInteractive(client as ModClient, ui);

      expect(ui.note.mock.calls[0][0]).toContain("Handle: Local Dev");
      expect(ui.note.mock.calls[0][0]).toContain(report.snapshot);
      expect(ui.note.mock.calls[0][0]).toContain(
        "Author account unavailable; suspension is not available.",
      );
      const [message, options] = ui.select.mock.calls[2];
      expect(message).toContain("author account unavailable");
      expect(options.map((option) => option.value)).toEqual([
        "delete",
        "dismiss",
        "back",
      ]);
      expect(client).toHaveBeenCalledWith(intent, { reportId: report.id });
      expect(
        client.mock.calls.some(([requested]) => requested === "suspend"),
      ).toBe(false);
      expect(ui.confirm).toHaveBeenCalledWith(
        "Apply this moderation action?",
        false,
      );
    },
  );

  it("uses the current linked target while retaining the historical author label", async () => {
    const linked = {
      ...report,
      handle: "Historical Author",
      suspendHandle: "calm-fox",
    };
    const ui = prompts(
      ["reports", "item:0", "suspend", "back", "exit"],
      [true],
      ["continued abuse"],
    );
    const client = vi.fn<ModClient>().mockImplementation(async (requested) => {
      if (requested === "reports") return reports([linked]) as never;
      return { intent: "suspend", ok: true } as never;
    });

    await runInteractive(client as ModClient, ui);

    expect(ui.note.mock.calls[0][0]).toContain("Handle: Historical Author");
    expect(ui.note.mock.calls[0][0]).toContain("Suspension target: calm-fox");
    expect(ui.select.mock.calls[2][1]).toContainEqual({
      value: "suspend",
      label: "Suspend calm-fox",
    });
    expect(client).toHaveBeenCalledWith("suspend", {
      handle: "calm-fox",
      reportId: report.id,
      reason: "continued abuse",
    });
    expect(ui.note.mock.calls[1][0]).toContain("suspend calm-fox");
    expect(ui.note.mock.calls[1][0]).not.toContain("Historical Author");
  });

  it("refuses a forged suspend selection when only the display author exists", async () => {
    const ui = prompts(
      ["reports", "item:0", "suspend", "back", "exit"],
      [true],
      ["abuse"],
    );
    const client = vi
      .fn<ModClient>()
      .mockResolvedValue(
        reports([{ ...report, handle: "Local Dev", suspendHandle: null }]),
      );

    await runInteractive(client as ModClient, ui);

    expect(client.mock.calls.every(([action]) => action === "reports")).toBe(
      true,
    );
    expect(ui.text).not.toHaveBeenCalled();
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it.each([false, Symbol("cancel")])(
    "makes no report mutation after confirmation cancellation: %s",
    async (confirmation) => {
      const ui = prompts(
        ["reports", "item:0", "suspend", "back", "exit"],
        [confirmation],
        ["abuse"],
      );
      const client = vi.fn<ModClient>().mockResolvedValue(
        reports([
          {
            ...report,
            handle: "Historical Author",
            suspendHandle: "calm-fox",
          },
        ]),
      );

      await runInteractive(client as ModClient, ui);

      expect(client.mock.calls.every(([action]) => action === "reports")).toBe(
        true,
      );
      expect(ui.confirm).toHaveBeenCalledWith(
        "Apply this moderation action?",
        false,
      );
      expect(ui.success).not.toHaveBeenCalled();
    },
  );
});
