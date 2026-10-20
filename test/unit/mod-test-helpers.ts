import { vi, type Mock } from "vitest";
import type {
  Page,
  ReportItem,
  ReportsView,
} from "../../app/lib/moderation-contract";
import type { MenuOption, PromptUi } from "../../scripts/mod-prompts";

export const report: ReportItem = {
  id: "10000000-0000-4000-8000-000000000001",
  messageId: "expired-message",
  snapshot: "Retained text after 48-hour expiry",
  reason: "targeted harassment",
  handle: "quiet-ibex",
  suspendHandle: "quiet-ibex",
  roomId: "campus-live",
  status: "open",
  createdAt: "2020-01-01T00:00:00.000Z",
};

export function page<T>(items: T[], number = 0, hasMore = false): Page<T> {
  return { items, page: number, pageSize: 25, total: items.length, hasMore };
}

export function reports(items: ReportItem[] = [report]): ReportsView {
  return { ...page(items), drain: { complete: true, unreachableRooms: [] } };
}

export function prompts(
  selections: Array<string | symbol>,
  confirmations: Array<boolean | symbol> = [],
  texts: Array<string | symbol> = [],
) {
  const take = <T>(values: T[]): T => {
    if (!values.length) throw new Error("Unexpected prompt");
    return values.shift()!;
  };
  const ui = {
    select: vi.fn(async (_message: string, _options: MenuOption[]) =>
      take(selections),
    ),
    confirm: vi.fn(async (_message: string, _initialValue: false) =>
      take(confirmations),
    ),
    text: vi.fn(
      async (
        _message: string,
        _validate: (value: string | undefined) => string | undefined,
      ) => take(texts),
    ),
    note: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    load: vi.fn(async <T>(_label: string, task: () => Promise<T>) =>
      task(),
    ) as Mock<PromptUi["load"]> & PromptUi["load"],
  } satisfies PromptUi;
  return ui;
}
