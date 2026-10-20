export const REPORT_FAILURES = {
  method: { code: "method_not_allowed", message: "Use POST.", status: 405 },
  origin: {
    code: "cross_origin",
    message: "Cross-origin requests are refused.",
    status: 403,
  },
  session: { code: "unauthenticated", message: "Sign in first.", status: 401 },
  suspended: {
    code: "suspended",
    message: "This account is suspended.",
    status: 403,
  },
  budget: {
    code: "rate_limited",
    message: "You have filed too many reports. Try again shortly.",
    status: 429,
  },
  body: {
    code: "bad_request",
    message: "Expected a JSON object.",
    status: 400,
  },
  room: { code: "bad_request", message: "roomId is required.", status: 400 },
  message: {
    code: "bad_request",
    message: "messageId is required.",
    status: 400,
  },
  outage: {
    code: "room_unreachable",
    message: "Could not read that message right now.",
    status: 503,
  },
  expired: {
    code: "message_not_found",
    message: "That message no longer exists.",
    status: 404,
  },
  self: {
    code: "bad_request",
    message: "You cannot report your own message.",
    status: 400,
  },
  legacy: {
    code: "member_not_found",
    message: "That handle no longer exists.",
    status: 404,
  },
  unavailable: {
    code: "unavailable",
    message: "That report could not be sent right now. Try again in a moment.",
    status: 503,
  },
} as const;

export function safeReportFailure(payload: unknown): string {
  if (!payload || typeof payload !== "object" || !("error" in payload))
    return REPORT_FAILURES.unavailable.message;
  const error = payload.error;
  if (!error || typeof error !== "object" || !("code" in error))
    return REPORT_FAILURES.unavailable.message;
  const choices = Object.values(REPORT_FAILURES).filter(
    (failure) => failure.code === error.code,
  );
  const exact =
    "message" in error
      ? choices.find((failure) => failure.message === error.message)
      : undefined;
  return (exact ?? choices[0])?.message ?? REPORT_FAILURES.unavailable.message;
}
