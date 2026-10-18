import {
  MAX_LOGS,
  type BugDevice,
  type BugLogEntry,
  scrubText,
} from "./bug-report";

const logs: BugLogEntry[] = [];
let installed = false;

function formatArg(arg: unknown): string {
  if (arg instanceof Error) {
    return arg.stack || `${arg.name}: ${arg.message}`;
  }
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function push(level: BugLogEntry["level"], parts: unknown[]) {
  const raw = parts.map(formatArg).join(" ");
  const message = scrubText(raw).slice(0, 1000);
  if (!message) return;
  logs.push({ t: Date.now(), level, message });
  if (logs.length > MAX_LOGS) {
    logs.splice(0, logs.length - MAX_LOGS);
  }
}

export function startBugLogCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.warn = (...args: unknown[]) => {
    push("warn", args);
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    push("error", args);
    origError(...args);
  };

  window.addEventListener("error", (event) => {
    push("unhandled", [
      event.error ??
        `${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
    ]);
  });

  window.addEventListener("unhandledrejection", (event) => {
    push("rejection", [event.reason]);
  });
}

export function getBugLogs(): BugLogEntry[] {
  return [...logs];
}

export function captureDevice(): BugDevice {
  if (typeof window === "undefined") {
    return {
      userAgent: "",
      platform: "",
      language: "",
      viewport: { width: 0, height: 0, dpr: 1 },
      screen: { width: 0, height: 0 },
      online: true,
      timezone: "UTC",
    };
  }
  const nav = window.navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return {
    userAgent: nav.userAgent ?? "",
    platform: nav.userAgentData?.platform ?? nav.platform ?? "",
    language: nav.language ?? "",
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
    },
    screen: {
      width: window.screen?.width ?? 0,
      height: window.screen?.height ?? 0,
    },
    online: nav.onLine ?? true,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  };
}

export async function captureScreenshot(): Promise<string | undefined> {
  if (
    typeof window === "undefined" ||
    !navigator.mediaDevices?.getDisplayMedia
  ) {
    return undefined;
  }

  let stream: MediaStream | undefined;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: "browser",
      } as MediaTrackConstraints,
      audio: false,
      // @ts-expect-error preferCurrentTab is a Chromium extension
      preferCurrentTab: true,
    });

    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();

    const maxEdge = 1600;
    const vw = video.videoWidth || window.innerWidth;
    const vh = video.videoHeight || window.innerHeight;
    const scale = Math.min(1, maxEdge / Math.max(vw, vh));
    const width = Math.max(1, Math.round(vw * scale));
    const height = Math.max(1, Math.round(vh * scale));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.8);
  } catch {
    return undefined;
  } finally {
    stream?.getTracks().forEach((t) => t.stop());
  }
}
