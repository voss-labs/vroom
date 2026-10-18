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
  label,
  value,
  note,
}: {
  label: string;
  value: number | null;
  note: string;
}) {
  return (
    <div className="stat">
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
        label="Open reports"
        value={openReports}
        note="awaiting a decision"
      />
      <Stat
        label="Online now"
        value={online}
        note={
          peakToday === null ? unreachable : `peak today ${count(peakToday)}`
        }
      />
      <Stat label="Suspended" value={suspended} note="cannot rejoin" />
      <Stat
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
