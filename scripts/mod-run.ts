import type { EventEmitter } from "node:events";
import { createModClient, readConfig, safeError } from "./mod-client";
import { runCommand } from "./mod-command";
import { runInteractive } from "./mod-interactive";
import { parseCommand } from "./mod-input";
import { clackUi, type PromptUi } from "./mod-prompts";
import { ModSession, type SessionConfig } from "./mod-session";

interface RunOptions {
  env?: Record<string, string | undefined>;
  tty?: boolean;
  output?: (text: string) => void;
  warning?: (text: string) => void;
  request?: typeof fetch;
  ui?: PromptUi;
  signals?: Pick<EventEmitter, "on" | "off">;
  session?: (config: SessionConfig) => ModSession;
  signalExit?: (code: number) => void;
}

export async function runCli(
  args: string[],
  options: RunOptions = {},
): Promise<number> {
  const output = options.output ?? ((text) => console.log(text));
  const warning = options.warning ?? ((text) => console.error(text));
  let session: ModSession | undefined;
  const redact = (text: string) => session?.redact(text) ?? text;
  let code = 0;
  const signals = options.signals ?? process;
  let cancel: () => void = () => undefined;
  const cancelled = new Promise<void>((resolve) => {
    cancel = resolve;
  });
  const interrupt = (exitCode: number) => {
    code = exitCode;
    cancel();
  };
  const onInterrupt = () => interrupt(130);
  const onTerminate = () => interrupt(143);
  try {
    const command = parseCommand(args);
    if (command.kind === "help") {
      output(command.text);
      return 0;
    }
    if (
      command.kind === "interactive" &&
      !(options.tty ?? (process.stdin.isTTY && process.stdout.isTTY))
    ) {
      warning(
        "Interactive mode needs a terminal. Use --help for explicit commands.",
      );
      return 1;
    }
    const config = readConfig(options.env ?? process.env);
    session =
      options.session?.(config) ??
      new ModSession(config, {
        warning: (text) => warning(redact(text)),
      });
    signals.on("SIGINT", onInterrupt);
    signals.on("SIGTERM", onTerminate);
    const active = session;
    let verified = false;
    const client = createModClient(
      {
        origin: config.origin,
        token: () => active.token(),
        unauthorized: () => (verified ? active.renew() : Promise.resolve()),
        signal: active.signal,
      },
      options.request,
    );
    await Promise.race([
      (async () => {
        await active.start();
        await client("status");
        verified = true;
        if (command.kind === "interactive") {
          await runInteractive(client, options.ui ?? clackUi(redact));
        } else {
          await runCommand(
            command,
            client,
            (text) => output(redact(text)),
            (text) => warning(redact(text)),
          );
        }
      })(),
      cancelled,
    ]);
  } catch (error) {
    warning(redact(safeError(error)));
    code = 1;
  } finally {
    await session?.revoke();
    signals.off("SIGINT", onInterrupt);
    signals.off("SIGTERM", onTerminate);
    if (code === 130 || code === 143) options.signalExit?.(code);
  }
  return code;
}
