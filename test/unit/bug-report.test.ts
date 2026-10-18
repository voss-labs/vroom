import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  buildGitHubIssueUrl,
  MAX_DESCRIPTION,
  MAX_SCREENSHOT_BYTES,
  scrubReport,
  scrubText,
  summarizeTitle,
  type BugReport,
} from "~/lib/bug-report";

const resolveActor = vi.fn();

vi.mock("~/lib/require-role.server", () => ({
  resolveActor: (...a: unknown[]) => resolveActor(...a),
}));

const { action: bugReportAction } = await import("~/routes/api.bug-report");

type Args = Parameters<typeof bugReportAction>[0];

function sampleReport(overrides: Partial<BugReport> = {}): BugReport {
  return {
    description: "Send button stays disabled after reconnecting",
    context: {
      url: "https://v-rooms.test/room/campus-live?token=secret-query-token",
      pathname: "/room/campus-live",
      referrer: "https://v-rooms.test/",
      timestamp: "2026-10-18T00:00:00.000Z",
      device: {
        userAgent: "Mozilla/5.0",
        platform: "Linux",
        language: "en-US",
        viewport: { width: 1280, height: 800, dpr: 2 },
        screen: { width: 1920, height: 1080 },
        online: true,
        timezone: "Asia/Kolkata",
      },
      logs: [
        {
          t: 1700000000000,
          level: "error",
          message:
            "WebSocket subprotocol vrooms.token.eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJxdWlldC1pYmV4In0.abcdef123456 failed",
        },
      ],
    },
    ...overrides,
  };
}

describe("bug-report scrubbing and formatting", () => {
  it("scrubs bearer tokens, JWTs, socket subprotocol tokens, and query secrets", () => {
    const raw =
      "Authorization: Bearer abcdefghijklmnop token=mysecret123 vrooms.token.eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.sig1234567890";
    const scrubbed = scrubText(raw);
    expect(scrubbed).not.toContain("abcdefghijklmnop");
    expect(scrubbed).not.toContain("mysecret123");
    expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(scrubbed).toContain("[redacted]");
  });

  it("clamps oversized descriptions and drops invalid or oversized screenshots", () => {
    const cleaned = scrubReport(
      sampleReport({
        description: "a".repeat(MAX_DESCRIPTION + 200),
        screenshot: "data:text/html;base64,PHNjcmlwdD4=",
      }),
    );
    expect(cleaned.description.length).toBeLessThanOrEqual(
      MAX_DESCRIPTION + 20,
    );
    expect(cleaned.description.endsWith("... [truncated]")).toBe(true);
    expect(cleaned.screenshot).toBeUndefined();

    const hugeScreenshot = scrubReport(
      sampleReport({
        screenshot:
          "data:image/jpeg;base64," + "A".repeat(MAX_SCREENSHOT_BYTES),
      }),
    );
    expect(hugeScreenshot.screenshot).toBeUndefined();

    const validScreenshot = scrubReport(
      sampleReport({
        screenshot: "data:image/jpeg;base64,abcd",
      }),
    );
    expect(validScreenshot.screenshot).toBe("data:image/jpeg;base64,abcd");
  });

  it("summarizes title with pathname prefix and builds a GitHub issue URL", () => {
    expect(
      summarizeTitle("Composer jumps on mobile\nMore details", "/room/hostel"),
    ).toBe("[/room/hostel] Composer jumps on mobile");

    const url = buildGitHubIssueUrl({
      ...scrubReport(sampleReport()),
      reporter: {
        pseudonym: "quiet-ibex",
        role: "student",
        kind: "device",
      },
    });
    expect(url).toContain("https://github.com/voss-labs/vroom/issues/new?");
    expect(url).toContain("quiet-ibex");
  });
});

describe("POST /api/bug-report", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.VROOMS_BUG_REPORT_URL;
    delete process.env.BUG_REPORT_URL;
    resolveActor.mockResolvedValue({
      kind: "device",
      member: {
        id: "m1",
        pseudonym: "calm-heron",
        isModerator: false,
      },
    });
  });

  function post(body: unknown, headers: Record<string, string> = {}): Args {
    return {
      request: new Request("https://v-rooms.test/api/bug-report", {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          "sec-fetch-site": "same-origin",
          ...headers,
        },
      }),
      params: {},
      context: {},
    } as unknown as Args;
  }

  it("refuses cross-origin requests", async () => {
    const res = await bugReportAction(
      post(sampleReport(), { "sec-fetch-site": "cross-site" }),
    );
    expect(res.status).toBe(403);
  });

  it("refuses an empty description", async () => {
    const res = await bugReportAction(
      post(sampleReport({ description: "   " })),
    );
    expect(res.status).toBe(400);
  });

  it("returns a scrubbed GitHub issue URL when no remote worker URL is configured", async () => {
    const res = await bugReportAction(post(sampleReport()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data?: { ok: boolean; issueUrl: string; mode: string };
    };
    expect(body.data?.ok).toBe(true);
    expect(body.data?.mode).toBe("github_prefill");
    expect(body.data?.issueUrl).toContain(
      "https://github.com/voss-labs/vroom/issues/new?",
    );
    expect(body.data?.issueUrl).not.toContain("secret-query-token");
  });
});
