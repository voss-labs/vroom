import { useMemo, useState } from "react";

import { BRAND, cn, handleColour } from "~/lib/utils";

export interface MemberListProps {
  members: string[];
  self: string;
  onMention?: (who: string) => void;
}

/** Shared by the right rail and the member sheet, so the two cannot drift. */
export function MemberList({ members, self, onMention }: MemberListProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return members;
    return members.filter((who) => who.toLowerCase().includes(q));
  }, [members, query]);

  if (members.length === 0) {
    return <div className="empty">nobody is online right now</div>;
  }

  return (
    <>
      {members.length > 5 && (
        <div className="px-1.5 pb-2">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find handle..."
            aria-label="Filter online handles"
            className="border-line-2 bg-panel-2 text-ink placeholder:text-ink-3 focus:border-brand h-10 w-full rounded-[var(--r-ctl)] border px-2.5 font-mono text-base focus:outline-none sm:h-8 sm:text-xs"
          />
        </div>
      )}
      {filtered.map((who) => {
        const mine = who === self;
        return (
          <div
            key={who}
            className={cn(
              "member",
              mine && "self",
              !mine && onMention && "cursor-pointer",
            )}
            onClick={() => {
              if (!mine && onMention) onMention(who);
            }}
            title={!mine && onMention ? `Mention @${who}` : undefined}
          >
            <i style={{ background: handleColour(who, self) }} />
            <span
              className={mine ? "font-semibold" : "text-ink-2"}
              style={mine ? { color: BRAND } : undefined}
            >
              {mine ? `${who} (you)` : who}
            </span>
          </div>
        );
      })}
      {filtered.length === 0 && (
        <div className="empty py-4 text-xs">no matching handle</div>
      )}
    </>
  );
}

export interface MemberRailProps {
  members: string[];
  self: string;
  onMention?: (who: string) => void;
}

export function MemberRail({ members, self, onMention }: MemberRailProps) {
  return (
    <aside className="members" aria-label="Online now">
      <div className="rail-card flex min-h-0 flex-1 flex-col">
        <div className="rail-card-head">
          <span className="inline-flex items-center gap-1.5">
            <span className="bg-ok inline-block h-1.5 w-1.5" />
            Online
          </span>
          <span>{members.length}</span>
        </div>
        <div className="rail-card-body min-h-0 flex-1 overflow-y-auto">
          <MemberList members={members} self={self} onMention={onMention} />
        </div>
      </div>

      <div className="rail-card flex-none">
        <div className="rail-card-head">
          <span>Session</span>
          <span>VRIP-13</span>
        </div>
        <div className="space-y-1.5 p-2.5 font-mono text-[11px]">
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-3">Identity</span>
            <span className="text-ink-2">device key</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-3">History</span>
            <span className="text-ink-2">48h SQLite</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-ink-3">PII stored</span>
            <span className="text-ok">none</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
