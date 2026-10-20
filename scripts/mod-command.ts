import type { ReportsView, StatusView } from "../app/lib/moderation-contract";
import type { ModClient } from "./mod-client";
import type { RequestCommand } from "./mod-input";
import { drainWarning } from "./mod-display";

export async function runCommand(
  command: RequestCommand,
  client: ModClient,
  output: (text: string) => void,
  warning: (text: string) => void,
): Promise<void> {
  const data = await client(command.action, command.body);
  if (command.action === "reports") {
    const message = drainWarning(data as ReportsView);
    if (message) warning(message);
  }
  if (command.action === "status" && (data as StatusView).aggregate === null) {
    warning(
      "Some rooms are unreachable. Their current state and aggregate are unknown.",
    );
  }
  output(JSON.stringify(data, null, 2));
}
