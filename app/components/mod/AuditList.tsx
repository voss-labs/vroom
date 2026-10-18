import { useMemo, useState } from "react";

import { auditTime, cn } from "~/lib/utils";

/**
 * The moderation trail, newest first.
 *
 * Two departures from the prototype, both deliberate. The time column carries a
 * date, because a trail read months later needs one. And the description names
 * the door the action came through: a row written by the script token is the
 * one row where "who did this" is only as good as who holds the token (VRIP-08).
 */

export interface AuditRow {
  id: string;
  action: string;
  actorHandle: string | null;
  actorKind: string;
  targetType: string;
  targetId: string | null;
  reportId: string | null;
  details: unknown;
  createdAt: string | Date;
}

const LABELS: Record<string, string> = {
  reveal: "reveal",
  delete_message: "delete",
  suspend: "suspend",
  restore: "restore",
  dismiss_report: "dismiss",
  room_close: "close",
  room_open: "open",
};

type AuditFilter =
  "all" | "suspend" | "delete_message" | "dismiss_report" | "room";

/** Muted red for anything that removes someone, brand orange for a reveal. */
function tone(action: string): string {
  if (action === "suspend" || action === "room_close") return "audit-a hot";
  if (action === "reveal") return "audit-a rev";
  return "audit-a";
}

function short(id: string | null): string {
  return id ? id.slice(0, 8) : "unknown";
}

function field(details: unknown, key: string): string | null {
  if (!details || typeof details !== "object") return null;
  const value = (details as Record<string, unknown>)[key];
  if (value === null || value === undefined) return null;
  return String(value);
}

function actorOf(entry: AuditRow): string {
  const who = entry.actorHandle ?? "a removed account";
  return entry.actorKind === "script" ? `${who} via the script` : who;
}

function describe(entry: AuditRow): string {
  const actor = actorOf(entry);
  const handle = field(entry.details, "handle");
  const reason = field(entry.details, "reason");

  switch (entry.action) {
    case "reveal": {
      const message = short(field(entry.details, "messageId"));
      return `identity resolved by ${actor}, bound to message ${message} on report ${short(entry.reportId)}`;
    }
    case "delete_message":
      return `message ${short(entry.targetId)} removed by ${actor}`;
    case "suspend":
      return `${handle ?? short(entry.targetId)} suspended by ${actor}, cannot rejoin${
        reason ? ` — ${reason}` : ""
      }`;
    case "restore":
      return `${handle ?? short(entry.targetId)} restored by ${actor}`;
    case "dismiss_report":
      return `report ${short(entry.targetId)} dismissed by ${actor}`;
    case "room_close":
      return `kill switch on by ${actor}, all posting halted${
        reason ? ` — ${reason}` : ""
      }`;
    case "room_open":
      return `kill switch off by ${actor}, posting resumed`;
    default:
      return `${entry.action} on ${entry.targetType} ${short(entry.targetId)} by ${actor}`;
  }
}

export function AuditList({ entries }: { entries: AuditRow[] }) {
  const [filter, setFilter] = useState<AuditFilter>("all");
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((entry) => {
      if (
        filter === "suspend" &&
        entry.action !== "suspend" &&
        entry.action !== "restore"
      ) {
        return false;
      }
      if (filter === "delete_message" && entry.action !== "delete_message") {
        return false;
      }
      if (filter === "dismiss_report" && entry.action !== "dismiss_report") {
        return false;
      }
      if (
        filter === "room" &&
        entry.action !== "room_close" &&
        entry.action !== "room_open"
      ) {
        return false;
      }
      if (!q) return true;
      return (
        describe(entry).toLowerCase().includes(q) ||
        (LABELS[entry.action] ?? entry.action).toLowerCase().includes(q)
      );
    });
  }, [entries, filter, search]);

  return (
    <section className="sec">
      <div className="sec-head pb-[14px]">
        <h2>Audit</h2>
        <p>
          Every moderator action across the console and CLI script, newest
          first.
        </p>
      </div>

      {entries.length > 0 && (
        <div className="toolbar pt-0">
          <input
            className="inp"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search audit trail..."
            aria-label="Search audit trail"
          />
          <div
            className="flex flex-wrap items-center gap-1"
            role="group"
            aria-label="Filter audit actions"
          >
            {(
              [
                ["all", "All"],
                ["suspend", "Suspensions"],
                ["delete_message", "Deletions"],
                ["dismiss_report", "Dismissals"],
                ["room", "Kill switch"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={cn(
                  "btn btn-sm",
                  filter === key && "border-brand text-ink bg-raised",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="border-line-2 border-t">
        {filtered.length === 0 ? (
          <div className="empty">
            {entries.length === 0
              ? "Nothing has been done yet."
              : "No audit entries match that filter."}
          </div>
        ) : (
          filtered.map((entry) => (
            <div className="audit-line" key={entry.id}>
              <span className="audit-t">{auditTime(entry.createdAt)}</span>
              <span className={tone(entry.action)}>
                {LABELS[entry.action] ?? entry.action}
              </span>
              <span className="audit-d">{describe(entry)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
