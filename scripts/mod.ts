import "dotenv/config";

import { createModClient, readConfig, safeError } from "./mod-client";
import { runCommand } from "./mod-command";
import { runInteractive } from "./mod-interactive";
import { parseCommand } from "./mod-input";
import { clackUi } from "./mod-prompts";

let redact = (text: string) => text;

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  if (command.kind === "help") {
    console.log(command.text);
    return;
  }
  if (command.kind === "interactive") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error(
        "Interactive mode needs a terminal. Use --help for explicit commands.",
      );
      process.exitCode = 1;
      return;
    }
  }
  const config = readConfig(process.env);
  redact = (text) => text.replaceAll(config.token, "[redacted]");
  const client = createModClient(config);
  if (command.kind === "interactive") {
    await runInteractive(client, clackUi(redact));
    return;
  }
  await runCommand(
    command,
    client,
    (text) => console.log(redact(text)),
    (text) => console.error(redact(text)),
  );
}

main().catch((error: unknown) => {
  console.error(redact(safeError(error)));
  process.exitCode = 1;
});
