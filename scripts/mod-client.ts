import type {
  AccountItem,
  AuditItem,
  ModAction,
  ModResult,
  Page,
  ReportsView,
  StatusView,
} from "../app/lib/moderation-contract";
import { CliError } from "./mod-errors";
import type { SessionConfig } from "./mod-session";

export { CliError, safeError } from "./mod-errors";

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
  token: string | (() => Promise<string>);
  unauthorized?: () => Promise<void>;
  signal?: AbortSignal;
}

interface RoomOutcome {
  roomId: string;
  reachable: boolean;
}

const ERROR_MESSAGES: Record<string, string> = {
  bad_token:
    "Authentication failed. Retry after session renewal. The action was not replayed.",
  moderation_auth_unavailable:
    "The server could not verify the CLI session. Retry later.",
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
): SessionConfig {
  const origin = env.VROOMS_ORIGIN;
  const databaseUrl = env.DATABASE_URL;
  if (!origin) throw new CliError("VROOMS_ORIGIN is not set.");
  if (!databaseUrl) throw new CliError("DATABASE_URL is not set.");
  try {
    const database = new URL(databaseUrl);
    if (
      !["postgres:", "postgresql:"].includes(database.protocol) ||
      !database.hostname
    ) {
      throw new Error();
    }
  } catch {
    throw new CliError("DATABASE_URL has an invalid format.");
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
  return { origin: url.origin, databaseUrl };
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
    const token =
      typeof config.token === "string" ? config.token : await config.token();
    const controller = new AbortController();
    const signal = config.signal
      ? AbortSignal.any([controller.signal, config.signal])
      : controller.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error());
      }, timeoutMs);
    });
    let result: { response: Response; payload: unknown };
    try {
      result = await Promise.race([
        (async () => {
          const response = await request(
            new URL(`/api/mod/${action}`, config.origin),
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
              redirect: "error",
              signal,
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
          return { response, payload };
        })(),
        timeout,
      ]);
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
    const { response, payload } = result;
    if (!response.ok || (object(payload) && "error" in payload)) {
      if (response.status === 401 && config.unauthorized)
        await config.unauthorized();
      throw failure(payload, response.status, token);
    }
    if (!object(payload) || !object(payload.data)) {
      throw new CliError("The server returned an invalid response.");
    }
    return payload.data as unknown as ModData[A];
  };
}
