import type {
  ModIntent,
  Page,
  ReportItem,
} from "../app/lib/moderation-contract";
import { safeError, type ModClient } from "./mod-client";
import { reasonError } from "./mod-input";
import {
  accountText,
  auditText,
  display,
  drainWarning,
  reportText,
  statusText,
} from "./mod-display";
import { clackUi, type MenuOption, type PromptUi } from "./mod-prompts";

class Cancelled extends Error {}

function answer<T>(value: T | symbol): T {
  if (typeof value === "symbol") throw new Cancelled();
  return value;
}

function pageOptions(page: Page<unknown>): MenuOption[] {
  return [
    ...(page.page > 0 ? [{ value: "previous", label: "Previous page" }] : []),
    ...(page.hasMore ? [{ value: "next", label: "Next page" }] : []),
    { value: "refresh", label: "Refresh" },
    { value: "back", label: "Back" },
  ];
}

function pageTitle(title: string, page: Page<unknown>): string {
  return `${title}: page ${page.page} (zero based), ${page.total} total`;
}

function nextPage(choice: string, current: number): number {
  return choice === "next"
    ? current + 1
    : choice === "previous"
      ? current - 1
      : current;
}

async function mutate(
  ui: PromptUi,
  client: ModClient,
  action: ModIntent,
  body: Record<string, unknown>,
  target: string,
  reason?: string,
): Promise<void> {
  ui.note(
    display(`Target: ${target}\nReason: ${reason || "not supplied"}`),
    "Review change",
  );
  const confirmed = answer(
    await ui.confirm("Apply this moderation action?", false),
  );
  if (!confirmed) {
    ui.info("No change made.");
    return;
  }
  const result = await ui.load("Applying moderation action", () =>
    client(action, body),
  );
  ui.success(`Action recorded: ${result.intent}`);
}

async function reportActions(
  ui: PromptUi,
  client: ModClient,
  report: ReportItem,
): Promise<void> {
  ui.note(reportText(report), "Report evidence");
  if (report.status !== "open") {
    ui.info("This report is closed. Its retained evidence remains available.");
    return;
  }
  const choice = answer(
    await ui.select("Action for this report", [
      { value: "delete", label: "Delete the reported message" },
      ...(report.handle
        ? [{ value: "suspend", label: `Suspend ${display(report.handle)}` }]
        : []),
      { value: "dismiss", label: "Dismiss the report" },
      { value: "back", label: "Back" },
    ]),
  );
  if (choice === "back") return;
  if (choice === "suspend" && report.handle) {
    const reason = answer(
      await ui.text(
        "Suspension reason (optional, recorded in audit)",
        reasonError,
      ),
    ).trim();
    await mutate(
      ui,
      client,
      "suspend",
      {
        handle: report.handle,
        reportId: report.id,
        reason: reason || undefined,
      },
      `suspend ${report.handle}; report ${report.id}`,
      reason,
    );
    return;
  }
  if (choice === "delete" || choice === "dismiss") {
    await mutate(
      ui,
      client,
      choice === "delete" ? "delete_message" : "dismiss_report",
      { reportId: report.id },
      `${choice === "delete" ? `delete message ${report.messageId}` : "dismiss report"}; report ${report.id}; room ${report.roomId}`,
      report.reason ?? undefined,
    );
  }
}

async function reports(ui: PromptUi, client: ModClient): Promise<void> {
  let page = 0;
  for (;;) {
    const view = await ui.load(
      "Reading retained reports and draining policy flags",
      () => client("reports", { page }),
    );
    const warning = drainWarning(view);
    if (warning) ui.warn(warning);
    if (!view.items.length) ui.info("No reports on this page.");
    const choice = answer(
      await ui.select(pageTitle("Reports", view), [
        ...view.items.map((report, index) => ({
          value: `item:${index}`,
          label: display(
            `${report.handle ?? "unavailable handle"} | ${report.roomId} | ${report.status}`,
          ),
          hint: display(`${report.createdAt} | ${report.id}`),
        })),
        ...pageOptions(view),
      ]),
    );
    if (choice === "back") return;
    if (choice.startsWith("item:")) {
      const report = view.items[Number(choice.slice(5))];
      if (report) await reportActions(ui, client, report);
    } else {
      page = nextPage(choice, page);
    }
  }
}

async function accounts(ui: PromptUi, client: ModClient): Promise<void> {
  let page = 0;
  for (;;) {
    const view = await ui.load("Reading accounts", () =>
      client("accounts", { page }),
    );
    if (!view.items.length) ui.info("No accounts on this page.");
    const choice = answer(
      await ui.select(pageTitle("Accounts", view), [
        ...view.items.map((account, index) => ({
          value: `item:${index}`,
          label: display(account.handle),
          hint: account.suspended ? "suspended" : "active",
        })),
        ...pageOptions(view),
      ]),
    );
    if (choice === "back") return;
    if (!choice.startsWith("item:")) {
      page = nextPage(choice, page);
      continue;
    }
    const account = view.items[Number(choice.slice(5))];
    if (!account) continue;
    ui.note(accountText(account), "Account");
    const action = account.suspended ? "restore" : "suspend";
    const selected = answer(
      await ui.select("Action for this account", [
        {
          value: action,
          label: account.suspended
            ? "Restore this account"
            : "Suspend this account",
        },
        { value: "back", label: "Back" },
      ]),
    );
    if (selected !== action) continue;
    const reason =
      action === "suspend"
        ? answer(
            await ui.text(
              "Suspension reason (optional, recorded in audit)",
              reasonError,
            ),
          ).trim()
        : undefined;
    await mutate(
      ui,
      client,
      action,
      { handle: account.handle, ...(reason ? { reason } : {}) },
      `${action} ${account.handle}`,
      reason,
    );
  }
}

async function audit(ui: PromptUi, client: ModClient): Promise<void> {
  let page = 0;
  for (;;) {
    const view = await ui.load("Reading moderation audit", () =>
      client("audit", { page }),
    );
    if (view.items.length) {
      ui.note(view.items.map(auditText).join("\n\n"), pageTitle("Audit", view));
    } else {
      ui.info("No audit entries on this page.");
    }
    const choice = answer(
      await ui.select(pageTitle("Audit", view), pageOptions(view)),
    );
    if (choice === "back") return;
    page = nextPage(choice, page);
  }
}

async function roomState(
  ui: PromptUi,
  client: ModClient,
  killed: boolean,
): Promise<void> {
  const reason = killed
    ? answer(
        await ui.text(
          "Closure reason (optional, recorded in audit)",
          reasonError,
        ),
      ).trim()
    : undefined;
  await mutate(
    ui,
    client,
    "set_room_state",
    { killed, ...(reason ? { reason } : {}) },
    `${killed ? "close" : "open"} all rooms`,
    reason,
  );
}

export async function runInteractive(
  client: ModClient,
  ui: PromptUi = clackUi(),
): Promise<void> {
  ui.intro();
  try {
    for (;;) {
      const choice = answer(
        await ui.select("What do you want to do?", [
          { value: "reports", label: "Reports" },
          { value: "accounts", label: "Accounts" },
          { value: "audit", label: "Audit" },
          { value: "status", label: "Room status" },
          { value: "close", label: "Close all rooms" },
          { value: "open", label: "Open all rooms" },
          { value: "exit", label: "Exit" },
        ]),
      );
      if (choice === "exit") {
        ui.outro();
        return;
      }
      try {
        switch (choice) {
          case "reports":
            await reports(ui, client);
            break;
          case "accounts":
            await accounts(ui, client);
            break;
          case "audit":
            await audit(ui, client);
            break;
          case "status": {
            const view = await ui.load("Reading room status", () =>
              client("status"),
            );
            ui.note(statusText(view), "Room status");
            break;
          }
          case "close":
            await roomState(ui, client, true);
            break;
          case "open":
            await roomState(ui, client, false);
            break;
        }
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        ui.error(safeError(error));
      }
    }
  } catch (error) {
    if (error instanceof Cancelled) {
      ui.cancel();
      return;
    }
    ui.error(safeError(error));
    throw error;
  }
}
