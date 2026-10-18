import type { ActionFunctionArgs } from "react-router";

import {
  buildGitHubIssueUrl,
  scrubReport,
  type BugBundle,
  type BugReport,
} from "~/lib/bug-report";
import { isSameOrigin } from "~/lib/origin.server";
import { resolveActor } from "~/lib/require-role.server";

const WINDOW_MS = 10 * 60_000;
const MAX_PER_WINDOW = 5;
const buckets = new Map<string, number[]>();

function checkRateLimit(key: string, now = Date.now()): boolean {
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

function fail(code: string, message: string, status: number) {
  return Response.json({ error: { code, message } }, { status });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return fail("method_not_allowed", "Use POST.", 405);
  }
  if (!isSameOrigin(request)) {
    return fail("cross_origin", "Cross-origin requests are refused.", 403);
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return fail("bad_request", "Expected a JSON body.", 400);
  }

  if (!raw || typeof raw !== "object") {
    return fail("bad_request", "Expected a bug report object.", 400);
  }

  const candidate = raw as Partial<BugReport>;
  if (
    typeof candidate.description !== "string" ||
    !candidate.description.trim()
  ) {
    return fail("bad_request", "Please describe what went wrong.", 400);
  }
  if (!candidate.context || typeof candidate.context !== "object") {
    return fail("bad_request", "Missing report context.", 400);
  }

  let reporter: BugBundle["reporter"] = null;
  try {
    const actor = await resolveActor(request);
    if (actor) {
      reporter = {
        pseudonym: actor.member.pseudonym ?? "unassigned",
        role: actor.member.isModerator ? "moderator" : "student",
        kind: actor.kind,
      };
    }
  } catch {
    // A bug report from an error boundary or when the DB is degraded still proceeds.
    reporter = null;
  }

  const rateKey = reporter?.pseudonym ?? "anon";
  if (!checkRateLimit(rateKey)) {
    return fail(
      "rate_limited",
      "You have sent several bug reports recently. Please wait a few minutes.",
      429,
    );
  }

  const cleaned = scrubReport({
    description: candidate.description,
    screenshot:
      typeof candidate.screenshot === "string"
        ? candidate.screenshot
        : undefined,
    context: {
      url: String(candidate.context.url ?? ""),
      pathname: String(candidate.context.pathname ?? "/"),
      referrer: String(candidate.context.referrer ?? ""),
      timestamp: String(
        candidate.context.timestamp ?? new Date().toISOString(),
      ),
      device: {
        userAgent: String(candidate.context.device?.userAgent ?? ""),
        platform: String(candidate.context.device?.platform ?? ""),
        language: String(candidate.context.device?.language ?? ""),
        viewport: {
          width: Number(candidate.context.device?.viewport?.width) || 0,
          height: Number(candidate.context.device?.viewport?.height) || 0,
          dpr: Number(candidate.context.device?.viewport?.dpr) || 1,
        },
        screen: {
          width: Number(candidate.context.device?.screen?.width) || 0,
          height: Number(candidate.context.device?.screen?.height) || 0,
        },
        online: Boolean(candidate.context.device?.online ?? true),
        timezone: String(candidate.context.device?.timezone ?? "UTC"),
      },
      logs: Array.isArray(candidate.context.logs) ? candidate.context.logs : [],
    },
  });

  const bundle: BugBundle = {
    ...cleaned,
    reporter,
  };

  const endpoint = (
    process.env.VROOMS_BUG_REPORT_URL ??
    process.env.BUG_REPORT_URL ??
    ""
  ).replace(/\/$/, "");

  if (endpoint) {
    try {
      const res = await fetch(`${endpoint}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(bundle),
      });
      const data = (await res.json().catch(() => ({}))) as {
        issueUrl?: string;
        issueNumber?: number;
        error?: string;
      };
      if (!res.ok) {
        return fail(
          "upstream_error",
          data.error || `Bug report service returned ${res.status}.`,
          502,
        );
      }
      return Response.json({
        data: {
          ok: true,
          issueUrl: data.issueUrl ?? buildGitHubIssueUrl(bundle),
          issueNumber: data.issueNumber,
          mode: "worker" as const,
        },
      });
    } catch {
      return fail(
        "upstream_unreachable",
        "Could not reach the bug report service.",
        502,
      );
    }
  }

  return Response.json({
    data: {
      ok: true,
      issueUrl: buildGitHubIssueUrl(bundle),
      mode: "github_prefill" as const,
    },
  });
}
