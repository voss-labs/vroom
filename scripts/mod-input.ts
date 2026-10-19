import { MOD_MAX_PAGE, type ModAction } from "../app/lib/moderation-contract";
import { CliError } from "./mod-client";

export const USAGE = `V Rooms moderation

  npm run manage                    interactive moderation
  npm run mod                       interactive moderation
  npm run mod -- reports [page]      retained reports and drain state
  npm run mod -- accounts [page]     account handles and suspensions
  npm run mod -- audit [page]        moderation audit
  npm run mod -- status              per-room reachability and state
  npm run mod -- close [reason]      close all rooms
  npm run mod -- open                open all rooms
  npm run mod -- suspend <handle> [reason]
  npm run mod -- restore <handle>
  npm run mod -- delete <reportId>
  npm run mod -- dismiss <reportId>

Pages are zero based. Explicit commands execute without confirmation.
Environment: VROOMS_ORIGIN, MOD_SCRIPT_TOKEN`;

export type RequestCommand = {
  kind: "request";
  action: ModAction;
  body: Record<string, unknown>;
};

type Command =
  RequestCommand | { kind: "interactive" } | { kind: "help"; text: string };

export function reasonError(value: string | undefined): string | undefined {
  if (
    value &&
    (value.trim().length > 1000 || /[\u0000-\u001f\u007f]/.test(value))
  ) {
    return "Use at most 1000 characters without control characters.";
  }
  return undefined;
}

export function parseCommand(args: string[]): Command {
  const [command, ...rest] = args;
  if (!command) return { kind: "interactive" };
  if (["--help", "-h", "help"].includes(command) && !rest.length) {
    return { kind: "help", text: USAGE };
  }
  const request = (action: ModAction, body = {}): RequestCommand => ({
    kind: "request",
    action,
    body,
  });
  const arity = (minimum: number, maximum: number) => {
    if (rest.length < minimum || rest.length > maximum) {
      throw new CliError("Invalid arguments. Use --help for command usage.");
    }
  };
  const reason = (value: string | undefined) => {
    if (reasonError(value)) throw new CliError(reasonError(value)!);
    return value?.trim() || undefined;
  };
  if (["reports", "accounts", "audit"].includes(command)) {
    arity(0, 1);
    const page = Number(rest[0] ?? 0);
    if (
      (rest[0] !== undefined && !/^(0|[1-9]\d*)$/.test(rest[0])) ||
      !Number.isSafeInteger(page) ||
      page > MOD_MAX_PAGE
    ) {
      throw new CliError(`Page must be an integer from 0 to ${MOD_MAX_PAGE}.`);
    }
    return request(command as "reports" | "accounts" | "audit", {
      page,
    });
  }
  switch (command) {
    case "status":
      arity(0, 0);
      return request("status");
    case "close":
      arity(0, 1);
      return request("set_room_state", {
        killed: true,
        reason: reason(rest[0]),
      });
    case "open":
      arity(0, 0);
      return request("set_room_state", { killed: false });
    case "suspend":
    case "restore":
      arity(1, command === "suspend" ? 2 : 1);
      if (!/^[a-z]+-[a-z]+(-\d{4})?$/.test(rest[0]) || rest[0].length > 64) {
        throw new CliError("Supply a valid account handle.");
      }
      return request(command, {
        handle: rest[0],
        ...(command === "suspend" ? { reason: reason(rest[1]) } : {}),
      });
    case "delete":
    case "dismiss":
      arity(1, 1);
      if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(rest[0])) {
        throw new CliError("Supply a valid report UUID.");
      }
      return request(
        command === "delete" ? "delete_message" : "dismiss_report",
        {
          reportId: rest[0],
        },
      );
    default:
      throw new CliError("Unknown command. Use --help for command usage.");
  }
}
