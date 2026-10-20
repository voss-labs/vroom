import { REPORT_FAILURES, safeReportFailure } from "~/lib/report-errors";

export class ReportSubmissionError extends Error {}

export function reportFailureMessage(error: unknown): string {
  return error instanceof ReportSubmissionError
    ? error.message
    : REPORT_FAILURES.unavailable.message;
}

export async function submitMessageReport(
  messageId: string,
  roomId: string,
  request: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await request("/api/report", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messageId, roomId }),
    });
  } catch {
    throw new ReportSubmissionError(REPORT_FAILURES.unavailable.message);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new ReportSubmissionError(safeReportFailure(payload));
  if (
    !payload ||
    typeof payload !== "object" ||
    !("data" in payload) ||
    !payload.data ||
    typeof payload.data !== "object" ||
    !("ok" in payload.data) ||
    payload.data.ok !== true
  ) {
    throw new ReportSubmissionError(REPORT_FAILURES.unavailable.message);
  }
}
