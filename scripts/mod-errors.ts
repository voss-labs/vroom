interface RoomOutcome {
  roomId: string;
  reachable: boolean;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly partial = false,
    readonly rooms: RoomOutcome[] = [],
    readonly fatal = false,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function databaseError(error: unknown, timedOut: boolean): CliError {
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  let message = "The database connection could not be completed.";
  if (timedOut || code === "57014") {
    message = "The database request timed out.";
  } else if (code === "42501" || code === "25006") {
    message =
      "DATABASE_URL does not have permission to register or manage CLI sessions.";
  } else if (code === "42P01" || code === "42703") {
    message =
      "The CLI session migration is missing. Apply the approved database migrations before retrying.";
  }
  return new CliError(message, false, [], true);
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
