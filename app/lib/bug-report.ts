export const MAX_DESCRIPTION = 4000;
export const MAX_LOGS = 60;
export const MAX_SCREENSHOT_BYTES = 1_500_000;

export interface BugDevice {
  userAgent: string;
  platform: string;
  language: string;
  viewport: { width: number; height: number; dpr: number };
  screen: { width: number; height: number };
  online: boolean;
  timezone: string;
}

export interface BugLogEntry {
  t: number;
  level: "warn" | "error" | "unhandled" | "rejection";
  message: string;
}

export interface BugContext {
  url: string;
  pathname: string;
  referrer: string;
  timestamp: string;
  device: BugDevice;
  logs: BugLogEntry[];
}

export interface BugReport {
  description: string;
  context: BugContext;
  screenshot?: string;
}

export interface BugBundle extends BugReport {
  reporter: {
    pseudonym: string;
    role: "student" | "moderator";
    kind: "device" | "vauth";
  } | null;
}

const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /\bvrooms\.token\.[A-Za-z0-9._-]{10,}\b/g,
  /\b(?:sk|rk|pk|ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{12,}\b/g,
  /([?&](?:token|access_token|id_token|code|state|key|secret|password|sig|signature)=)[^&\s#]+/gi,
  /\b((?:token|secret|password|authorization|cookie)\s*[:=]\s*["']?)[^\s"',;}{]{6,}/gi,
];

export function scrubText(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (_match, prefix) =>
      typeof prefix === "string" ? `${prefix}[redacted]` : "[redacted]",
    );
  }
  return out;
}

export function clamp(input: string, max: number): string {
  const s = scrubText(input);
  return s.length <= max ? s : `${s.slice(0, max)}... [truncated]`;
}

export function scrubReport(report: BugReport): BugReport {
  return {
    description: clamp(report.description.trim(), MAX_DESCRIPTION),
    screenshot:
      report.screenshot &&
      report.screenshot.startsWith("data:image/") &&
      report.screenshot.length <= MAX_SCREENSHOT_BYTES
        ? report.screenshot
        : undefined,
    context: {
      url: clamp(report.context.url, 500),
      pathname: clamp(report.context.pathname, 300),
      referrer: clamp(report.context.referrer, 500),
      timestamp: clamp(report.context.timestamp, 64),
      device: {
        userAgent: clamp(report.context.device.userAgent, 400),
        platform: clamp(report.context.device.platform, 120),
        language: clamp(report.context.device.language, 64),
        viewport: {
          width: Number(report.context.device.viewport.width) || 0,
          height: Number(report.context.device.viewport.height) || 0,
          dpr: Number(report.context.device.viewport.dpr) || 1,
        },
        screen: {
          width: Number(report.context.device.screen.width) || 0,
          height: Number(report.context.device.screen.height) || 0,
        },
        online: Boolean(report.context.device.online),
        timezone: clamp(report.context.device.timezone, 120),
      },
      logs: (report.context.logs ?? []).slice(-MAX_LOGS).map((entry) => ({
        t: Number(entry.t) || 0,
        level: entry.level,
        message: clamp(String(entry.message ?? ""), 1000),
      })),
    },
  };
}

export function summarizeTitle(description: string, pathname: string): string {
  const firstLine =
    description
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? "Bug report";
  const short =
    firstLine.length > 72 ? `${firstLine.slice(0, 69)}...` : firstLine;
  return pathname && pathname !== "/" ? `[${pathname}] ${short}` : short;
}

export function buildGitHubIssueUrl(
  bundle: BugBundle,
  repo = "voss-labs/vroom",
): string {
  const title = summarizeTitle(bundle.description, bundle.context.pathname);
  const d = bundle.context.device;
  const who = bundle.reporter
    ? `${bundle.reporter.pseudonym} (${bundle.reporter.role}, ${bundle.reporter.kind})`
    : "unauthenticated";
  const logsBlock =
    bundle.context.logs.length > 0
      ? bundle.context.logs
          .slice(-15)
          .map(
            (l) =>
              `[${new Date(l.t).toISOString()} ${l.level}] ${l.message.slice(0, 240)}`,
          )
          .join("\n")
      : "None captured.";

  const bodyLines = [
    "### What happened?",
    "",
    bundle.description,
    "",
    "### Context",
    "",
    `- **Page**: \`${bundle.context.pathname}\``,
    `- **Reporter**: \`${who}\``,
    `- **Viewport**: ${d.viewport.width}x${d.viewport.height} @${d.viewport.dpr}x (${d.platform || "unknown"}, ${d.timezone})`,
    `- **User Agent**: \`${d.userAgent}\``,
    `- **Timestamp**: ${bundle.context.timestamp}`,
    "",
    "### Recent tab errors",
    "",
    "```text",
    logsBlock,
    "```",
  ];

  const params = new URLSearchParams({
    title,
    body: bodyLines.join("\n"),
  });
  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}
