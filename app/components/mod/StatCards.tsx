/**
 * The four numbers above the queue. Three of them are Durable Object reads and
 * arrive as null when the object is unreachable — they show an em dash rather
 * than a zero, because a zero here reads as "nobody is online" (VRIP-08).
 */

interface StatCardsProps {
  openReports: number;
  suspended: number;
  online: number | null;
  peakToday: number | null;
  messages: number | null;
  /** Epoch ms of the oldest message kept, or null. */
  since: number | null;
}

/** Fixed locale on both sides of the render, so hydration cannot disagree. */
function count(value: number): string {
  return value.toLocaleString("en-US");
}

function day(at: number): string {
  return new Date(at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
}

function Stat({
  tag,
  label,
  value,
  note,
  tone,
}: {
  tag: string;
  label: string;
  value: number | null;
  note: string;
  tone?: "alert" | "ok";
}) {
  return (
    <div className="stat overflow-hidden p-0">
      <div className="rail-card-head px-3.5 py-1.5">
        <span>{tag}</span>
        {tone === "alert" && value && value > 0 ? (
          <span className="text-neg">action needed</span>
        ) : tone === "ok" && value !== null ? (
          <span className="text-ok">live</span>
        ) : null}
      </div>
      <div className="p-3.5">
        <div className="stat-k">{label}</div>
        <div className="stat-v">
          {value === null ? (
            <>
              <span aria-hidden="true">—</span>
              <span className="sr">unavailable</span>
            </>
          ) : (
            count(value)
          )}
        </div>
        <div className="stat-n">{note}</div>
      </div>
    </div>
  );
}

export function StatCards({
  openReports,
  suspended,
  online,
  peakToday,
  messages,
  since,
}: StatCardsProps) {
  const unreachable = "the room is unreachable";

  return (
    <div className="stats">
      <Stat
        tag="Queue"
        label="Open reports"
        value={openReports}
        note="awaiting a decision"
        tone="alert"
      />
      <Stat
        tag="Presence"
        label="Online now"
        value={online}
        note={
          peakToday === null ? unreachable : `peak today ${count(peakToday)}`
        }
        tone="ok"
      />
      <Stat
        tag="Enforcement"
        label="Suspended"
        value={suspended}
        note="cannot rejoin"
      />
      <Stat
        tag="Retention"
        label="Messages in 48h window"
        value={messages}
        note={
          messages === null
            ? unreachable
            : since === null
              ? "nothing in last 48h"
              : `oldest from ${day(since)}`
        }
      />
    </div>
  );
}
