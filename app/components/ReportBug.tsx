import {
  Bug,
  Camera,
  Check,
  ChevronRight,
  ExternalLink,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  captureDevice,
  captureScreenshot,
  getBugLogs,
  startBugLogCapture,
} from "~/lib/bug-capture.client";
import {
  MAX_DESCRIPTION,
  type BugDevice,
  type BugLogEntry,
  type BugReport,
} from "~/lib/bug-report";

const OPEN_EVENT = "vrooms:open-bug-report";

export function openBugReport(prefill?: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT, { detail: { prefill } }));
}

type SubmitState =
  | { kind: "idle" }
  | { kind: "sending" }
  | {
      kind: "sent";
      issueUrl: string;
      issueNumber?: number;
      mode: "worker" | "github_prefill";
    }
  | { kind: "error"; message: string };

export function ReportBug() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [screenshot, setScreenshot] = useState<string | undefined>(undefined);
  const [capturing, setCapturing] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<{
    pathname: string;
    device: BugDevice;
    logs: BugLogEntry[];
  } | null>(null);
  const [state, setState] = useState<SubmitState>({ kind: "idle" });

  useEffect(() => {
    startBugLogCapture();
  }, []);

  const openModal = useCallback((prefill?: string) => {
    setSnapshot({
      pathname: typeof window !== "undefined" ? window.location.pathname : "/",
      device: captureDevice(),
      logs: getBugLogs(),
    });
    if (prefill) {
      setDescription((prev) => (prev ? prev : prefill));
    }
    setState({ kind: "idle" });
    setOpen(true);
    dialogRef.current?.showModal();
  }, []);

  const closeModal = useCallback(() => {
    dialogRef.current?.close();
    setOpen(false);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ prefill?: string }>).detail;
      openModal(detail?.prefill);
    };
    window.addEventListener(OPEN_EVENT, handler);
    return () => window.removeEventListener(OPEN_EVENT, handler);
  }, [openModal]);

  const handleCapture = async () => {
    const dialog = dialogRef.current;
    setCapturing(true);
    dialog?.close();
    try {
      await new Promise((r) => setTimeout(r, 150));
      const dataUrl = await captureScreenshot();
      if (dataUrl) setScreenshot(dataUrl);
    } finally {
      dialog?.showModal();
      setCapturing(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = description.trim();
    if (!trimmed || state.kind === "sending") return;

    setState({ kind: "sending" });
    const snap = snapshot ?? {
      pathname: window.location.pathname,
      device: captureDevice(),
      logs: getBugLogs(),
    };

    const report: BugReport = {
      description: trimmed,
      screenshot,
      context: {
        url: window.location.href,
        pathname: snap.pathname,
        referrer: document.referrer,
        timestamp: new Date().toISOString(),
        device: snap.device,
        logs: snap.logs,
      },
    };

    try {
      const res = await fetch("/api/bug-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        data?: {
          ok?: boolean;
          issueUrl?: string;
          issueNumber?: number;
          mode?: "worker" | "github_prefill";
        };
        error?: { message?: string };
      };
      if (!res.ok || !payload.data?.issueUrl) {
        setState({
          kind: "error",
          message: payload.error?.message || `Request failed (${res.status}).`,
        });
        return;
      }
      setState({
        kind: "sent",
        issueUrl: payload.data.issueUrl,
        issueNumber: payload.data.issueNumber,
        mode: payload.data.mode ?? "github_prefill",
      });
      setDescription("");
      setScreenshot(undefined);
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error",
      });
    }
  };

  const deviceLine = snapshot
    ? `${snapshot.device.viewport.width}x${snapshot.device.viewport.height} @${snapshot.device.viewport.dpr}x · ${snapshot.device.platform || "unknown platform"} · ${snapshot.device.timezone}`
    : "";

  return (
    <>
      <button
        type="button"
        onClick={() => openModal()}
        aria-label="Report a bug"
        title="Report a bug"
        data-testid="bug-report-trigger"
        className="border-line-2 bg-panel-2/95 text-ink-2 hover:border-brand/50 hover:bg-raised hover:text-ink fixed right-4 bottom-4 z-40 flex h-9 items-center gap-1.5 rounded-[4px] border px-3 font-mono text-xs font-medium shadow-lg backdrop-blur transition-colors max-[1040px]:bottom-[74px]"
      >
        <Bug className="text-brand size-3.5" />
        <span className="max-[480px]:sr-only">Bug</span>
      </button>

      <dialog
        ref={dialogRef}
        onClose={() => setOpen(false)}
        onClick={(e) => {
          if (e.target === dialogRef.current) closeModal();
        }}
        className="border-line-2 bg-panel text-ink m-auto w-[calc(100%-1.5rem)] max-w-lg rounded-[4px] border p-0 shadow-2xl backdrop:bg-black/75 backdrop:backdrop-blur-[2px]"
      >
        {open && (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4 p-5">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <Bug className="text-brand size-4" />
                  <h2 className="text-base font-semibold tracking-tight">
                    Report a bug
                  </h2>
                </div>
                <p className="text-ink-2 mt-1 text-xs leading-relaxed">
                  Opens an issue on the V Rooms repository. Nothing from the
                  conversation is collected — only what is listed below.
                </p>
              </div>
              <button
                type="button"
                onClick={closeModal}
                aria-label="Close"
                className="text-ink-3 hover:bg-raised hover:text-ink -m-1 rounded-[4px] p-1.5 transition-colors"
              >
                <X className="size-4" />
              </button>
            </div>

            <label className="flex flex-col gap-1.5">
              <span className="text-ink-2 text-xs font-medium">
                What went wrong?
              </span>
              <textarea
                required
                rows={4}
                maxLength={MAX_DESCRIPTION}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What were you doing, what did you expect, and what happened instead?"
                className="border-line-2 bg-ground focus:border-brand text-ink placeholder:text-ink-3 w-full resize-y rounded-[4px] border px-3 py-2 text-sm leading-relaxed focus:outline-none"
              />
              {description.length >= MAX_DESCRIPTION * 0.8 && (
                <span className="text-ink-3 self-end font-mono text-[11px] tabular-nums">
                  {description.length} / {MAX_DESCRIPTION}
                </span>
              )}
            </label>

            <div className="border-line-2 bg-ground/70 rounded-[4px] border text-xs">
              <button
                type="button"
                onClick={() => setDetailsOpen((v) => !v)}
                className="text-ink-2 hover:text-ink flex w-full items-center justify-between px-3 py-2 text-left font-medium transition-colors"
              >
                <span>
                  What gets sent
                  {snapshot && snapshot.logs.length > 0
                    ? ` (includes ${snapshot.logs.length} console ${snapshot.logs.length === 1 ? "error" : "errors"})`
                    : ""}
                </span>
                <ChevronRight
                  className={`size-3.5 transition-transform ${detailsOpen ? "rotate-90" : ""}`}
                />
              </button>

              {detailsOpen && snapshot && (
                <dl className="border-line text-ink-3 space-y-2 border-t px-3 py-2.5 text-[11px]">
                  <div>
                    <dt className="text-ink-2 font-medium">Page</dt>
                    <dd className="truncate font-mono">{snapshot.pathname}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-2 font-medium">Who you are</dt>
                    <dd className="font-mono">
                      Pseudonymous session handle only (no email, name, or IP)
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-2 font-medium">
                      Browser and device
                    </dt>
                    <dd className="font-mono">{deviceLine}</dd>
                    <dd className="mt-0.5 truncate font-mono opacity-80">
                      {snapshot.device.userAgent}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-ink-2 font-medium">
                      Recent errors from this tab ({snapshot.logs.length})
                    </dt>
                    {snapshot.logs.length === 0 ? (
                      <dd className="italic">None captured.</dd>
                    ) : (
                      <dd className="border-line bg-panel mt-1 max-h-28 overflow-auto rounded-[4px] border p-1.5 font-mono text-[10px] leading-relaxed">
                        {snapshot.logs.map((entry, idx) => (
                          <div key={idx} className="truncate">
                            [{entry.level}] {entry.message}
                          </div>
                        ))}
                      </dd>
                    )}
                  </div>
                </dl>
              )}
            </div>

            <div className="flex flex-col gap-2">
              {screenshot ? (
                <div className="border-line-2 bg-ground/70 flex items-center justify-between gap-2 rounded-[4px] border p-2">
                  <img
                    src={screenshot}
                    alt="Captured screenshot preview"
                    className="border-line h-14 w-auto rounded-[4px] border object-cover"
                  />
                  <div className="text-ink-3 flex-1 text-xs">
                    Screenshot attached (
                    {Math.round((screenshot.length * 0.75) / 1024)} KB).
                  </div>
                  <button
                    type="button"
                    onClick={() => setScreenshot(undefined)}
                    className="text-ink-3 hover:bg-raised hover:text-ink inline-flex items-center gap-1 rounded-[4px] px-2 py-1 text-xs transition-colors"
                  >
                    <Trash2 className="size-3.5" />
                    Remove
                  </button>
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  <button
                    type="button"
                    disabled={capturing}
                    onClick={handleCapture}
                    className="border-line-2 text-ink-2 hover:bg-raised hover:text-ink inline-flex items-center gap-1.5 self-start rounded-[4px] border border-dashed px-2.5 py-1.5 text-xs transition-colors disabled:opacity-50"
                  >
                    <Camera className="size-3.5" />
                    {capturing
                      ? "Waiting for selection..."
                      : "Attach a screenshot of this tab"}
                  </button>
                  <p className="text-ink-3 text-[11px] leading-snug">
                    A screenshot of this page can contain messages visible on
                    your screen, and everyone who can see the issue can see
                    them. Attach one only if the bug cannot be understood
                    without it.
                  </p>
                </div>
              )}
            </div>

            {state.kind === "error" && (
              <p className="border-neg/40 bg-neg/10 text-neg rounded-[4px] border px-3 py-2 text-xs">
                Could not send report: {state.message}
              </p>
            )}

            {state.kind === "sent" && (
              <div className="border-ok/40 bg-ok/10 text-ink flex items-center justify-between gap-2 rounded-[4px] border px-3 py-2 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <Check className="text-ok size-3.5 shrink-0" />
                  {state.mode === "worker" && state.issueNumber
                    ? `Reported as #${state.issueNumber}.`
                    : "Diagnostic report ready."}
                </span>
                <a
                  href={state.issueUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-brand inline-flex items-center gap-1 font-medium underline underline-offset-2"
                >
                  {state.mode === "worker" ? "Open issue" : "Open on GitHub"}
                  <ExternalLink className="size-3" />
                </a>
              </div>
            )}

            <div className="border-line flex items-center justify-end gap-2 border-t pt-3">
              <button type="button" onClick={closeModal} className="btn btn-sm">
                Cancel
              </button>
              <button
                type="submit"
                disabled={!description.trim() || state.kind === "sending"}
                className="btn btn-primary btn-sm"
              >
                {state.kind === "sending" ? "Sending..." : "Send report"}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
