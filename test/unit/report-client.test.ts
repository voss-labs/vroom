import { describe, expect, it, vi } from "vitest";

import { REPORT_FAILURES, safeReportFailure } from "~/lib/report-errors";
import {
  reportFailureMessage,
  ReportSubmissionError,
  submitMessageReport,
} from "~/lib/report.client";

function client(response: Response) {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe("student report results", () => {
  it.each([false, true])(
    "preserves successful and duplicate reports (%s)",
    async (duplicate) => {
      const request = client(Response.json({ data: { ok: true, duplicate } }));
      await expect(
        submitMessageReport("legacy-message", "campus-live", request),
      ).resolves.toBeUndefined();
      expect(request).toHaveBeenCalledWith("/api/report", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messageId: "legacy-message",
          roomId: "campus-live",
        }),
      });
    },
  );

  it.each([
    "session",
    "suspended",
    "budget",
    "outage",
    "expired",
    "self",
    "legacy",
  ] as const)("conveys the approved returned %s failure", async (kind) => {
    const { code, message, status } = REPORT_FAILURES[kind];
    const request = client(
      Response.json({ error: { code, message } }, { status }),
    );
    try {
      await submitMessageReport("legacy-message", "campus-live", request);
      throw new Error("Expected report failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ReportSubmissionError);
      expect(reportFailureMessage(error)).toBe(message);
    }
  });

  it("allows retry after failure without remembering a false success", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: REPORT_FAILURES.outage }, { status: 503 }),
      )
      .mockResolvedValueOnce(
        Response.json({ data: { ok: true } }),
      ) as unknown as typeof fetch;
    await expect(
      submitMessageReport("m1", "hostel", request),
    ).rejects.toBeInstanceOf(ReportSubmissionError);
    await expect(
      submitMessageReport("m1", "hostel", request),
    ).resolves.toBeUndefined();
  });

  it("does not display an unknown server exception or internal fields", async () => {
    const request = client(
      Response.json(
        {
          error: {
            code: "database_exception",
            message: "private database details",
          },
        },
        { status: 500 },
      ),
    );
    await expect(submitMessageReport("m1", "hostel", request)).rejects.toThrow(
      REPORT_FAILURES.unavailable.message,
    );
    expect(
      safeReportFailure({
        error: { code: "unavailable", message: "private database details" },
      }),
    ).toBe(REPORT_FAILURES.unavailable.message);
  });

  it("handles a network error without displaying its details", async () => {
    const request = vi.fn(async () => {
      throw new Error("private network details");
    }) as unknown as typeof fetch;
    await expect(submitMessageReport("m1", "hostel", request)).rejects.toThrow(
      REPORT_FAILURES.unavailable.message,
    );
    expect(reportFailureMessage(new Error("private exception"))).toBe(
      REPORT_FAILURES.unavailable.message,
    );
  });

  it.each([
    new Response("not json", { status: 200 }),
    Response.json(null),
    Response.json({ data: { ok: false } }),
  ])(
    "does not mark an invalid success response as reported",
    async (response) => {
      await expect(
        submitMessageReport("m1", "hostel", client(response)),
      ).rejects.toBeInstanceOf(ReportSubmissionError);
    },
  );

  it.each([null, [], {}, { error: null }, { error: "private exception" }])(
    "handles malformed failure payload %j",
    (payload) => {
      expect(safeReportFailure(payload)).toBe(
        REPORT_FAILURES.unavailable.message,
      );
    },
  );
});
