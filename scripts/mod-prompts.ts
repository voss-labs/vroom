import {
  cancel,
  confirm,
  intro,
  log,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { display } from "./mod-display";

export interface MenuOption {
  value: string;
  label: string;
  hint?: string;
}

export interface PromptUi {
  select(message: string, options: MenuOption[]): Promise<string | symbol>;
  confirm(message: string, initialValue: false): Promise<boolean | symbol>;
  text(
    message: string,
    validate: (value: string | undefined) => string | undefined,
  ): Promise<string | symbol>;
  note(text: string, title: string): void;
  info(text: string): void;
  warn(text: string): void;
  error(text: string): void;
  success(text: string): void;
  intro(): void;
  outro(): void;
  cancel(): void;
  load<T>(label: string, task: () => Promise<T>): Promise<T>;
}

export function clackUi(redact: (text: string) => string = display): PromptUi {
  const clean = (value: string) => redact(display(value));
  return {
    select: (message, options) =>
      select({
        message: clean(message),
        options: options.map((option) => ({
          ...option,
          label: clean(option.label).replace(/[\r\n\t]/g, " "),
          hint: option.hint
            ? clean(option.hint).replace(/[\r\n\t]/g, " ")
            : undefined,
        })),
      }),
    confirm: (message, initialValue) =>
      confirm({ message: clean(message), initialValue }),
    text: (message, validate) => text({ message: clean(message), validate }),
    note: (value, title) => note(clean(value), clean(title)),
    info: (value) => log.info(clean(value)),
    warn: (value) => log.warn(clean(value)),
    error: (value) => log.error(clean(value)),
    success: (value) => log.success(clean(value)),
    intro: () => intro("V Rooms moderation"),
    outro: () => outro("Moderation session ended."),
    cancel: () => cancel("Cancelled. No further changes were requested."),
    load: async (label, task) => {
      const progress = spinner();
      progress.start(clean(label));
      try {
        const result = await task();
        progress.stop("Request complete.");
        return result;
      } catch (error) {
        progress.error("Request failed.");
        throw error;
      }
    },
  };
}
