import type {
  AccountItem,
  AuditItem,
  ModAction,
  ModResult,
  Page,
  ReportsView,
  StatusView,
} from "../app/lib/moderation-contract";

interface ModData {
  reports: ReportsView;
  accounts: Page<AccountItem>;
  audit: Page<AuditItem>;
  status: StatusView;
  set_room_state: ModResult;
  suspend: ModResult;
  restore: ModResult;
  delete_message: ModResult;
  dismiss_report: ModResult;
}

export type ModClient = <A extends ModAction>(
  action: A,
  body?: Record<string, unknown>,
) => Promise<ModData[A]>;

interface ClientConfig {
  origin: string;
  token: string;
}

interface RoomOutcome {
  roomId: string;
  reachable: boolean;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly partial = false,
    readonly rooms: RoomOutcome[] = [],
  ) {
    super(message);
    this.name = "CliError";
  }
}

const ERROR_MESSAGES: Record<string, string> = {
  bad_token: "Authentication failed. Check MOD_SCRIPT_TOKEN.",
  not_moderator: "The designated account is not an active V Auth moderator.",
  suspended: "The designated moderator is suspended.",
  bad_request: "The server rejected the request. Check its fields.",
  rate_limited: "Too many failed authentication attempts. Wait and retry.",
  report_not_found: "The report no longer exists.",
  report_target_unavailable:
    "This report has no current author account to suspend. Refresh the reports.",
  report_target_mismatch:
    "The selected account does not match this report. Refresh the reports.",
  member_not_found: "No account exists for that handle.",
  already_resolved: "The report is already closed. Refresh the reports.",
  room_unreachable: "One or more rooms could not be reached.",
  internal_error: "The server could not complete the request.",
};

export function readConfig(
  env: Record<string, string | undefined>,
): ClientConfig {
  const origin = env.VROOMS_ORIGIN;
  const token = env.MOD_SCRIPT_TOKEN;
  if (!origin) throw new CliError("VROOMS_ORIGIN is not set.");
  if (!token) throw new CliError("MOD_SCRIPT_TOKEN is not set.");
  if (!/^[^\s\u0000-\u001f\u007f]+$/.test(token)) {
    throw new CliError("MOD_SCRIPT_TOKEN has an invalid format.");
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new CliError("VROOMS_ORIGIN must be a valid root origin.");
  }
  if (
    !/^https?:\/\/[^/?#\\\s@]+\/?$/i.test(origin) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new CliError(
      "VROOMS_ORIGIN must be a root origin without credentials, path, query or fragment.",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CliError("VROOMS_ORIGIN requires HTTPS except on loopback.");
  }
  return { origin: url.origin, token };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function failure(payload: unknown, status: number, token: string): CliError {
  const error = object(payload) && object(payload.error) ? payload.error : null;
  const code = error && typeof error.code === "string" ? error.code : "";
  const message = Object.hasOwn(ERROR_MESSAGES, code)
    ? ERROR_MESSAGES[code]
    : `Moderation request failed (HTTP ${status}).`;
  const rooms: RoomOutcome[] = [];
  if (error && Array.isArray(error.rooms)) {
    for (const room of error.rooms) {
      if (
        object(room) &&
        typeof room.roomId === "string" &&
        /^[a-z][a-z0-9-]{0,63}$/.test(room.roomId) &&
        !room.roomId.includes(token) &&
        typeof room.reachable === "boolean"
      ) {
        rooms.push({ roomId: room.roomId, reachable: room.reachable });
      }
    }
  }
  return new CliError(message, error?.partial === true, rooms);
}

export function createModClient(
  config: ClientConfig,
  request: typeof fetch = fetch,
  timeoutMs = 15_000,
): ModClient {
  return async <A extends ModAction>(
    action: A,
    body: Record<string, unknown> = {},
  ): Promise<ModData[A]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await request(
        new URL(`/api/mod/${action}`, config.origin),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: controller.signal,
        },
      );
      if (
        response.redirected ||
        (response.status >= 300 && response.status < 400)
      ) {
        throw new CliError(
          "The server redirected the request. No redirect was followed.",
        );
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok || (object(payload) && "error" in payload)) {
        throw failure(payload, response.status, config.token);
      }
      if (!object(payload) || !object(payload.data)) {
        throw new CliError("The server returned an invalid response.");
      }
      return payload.data as unknown as ModData[A];
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        controller.signal.aborted
          ? "The request timed out. Its outcome is unknown; check status and audit before retrying."
          : "The request could not be completed. Its outcome is unknown; check status and audit before retrying.",
      );
    } finally {
      clearTimeout(timer);
    }
  };
}

export function safeError(error: unknown): string {
  if (!(error instanceof CliError)) return "Moderation could not be completed.";
  const lines = [error.message];
  if (error.partial) {
    lines.push(
      "Enforcement may already have happened in some rooms. No rollback was performed. Check room status before retrying.",
    );
  }
  for (const room of error.rooms) {
    lines.push(
      `${room.roomId}: ${room.reachable ? "reachable; enforcement succeeded" : "unreachable; enforcement unconfirmed"}`,
    );
  }
  return lines.join("\n");
}
