import { useState } from "react";
import { Link } from "react-router";

import type { RoomPulse } from "~/lib/room.server";
import { ROOM_IDS, ROOMS, type RoomId } from "~/lib/rooms";
import { cn } from "~/lib/utils";

export interface HandlePanelProps {
  pseudonym: string;
  blockCount: number;
  onClearBlocks: () => void;
  className?: string;
}

/** Pinned to the foot of the rail, and reused inside the member sheet. */
export function HandlePanel({
  pseudonym,
  blockCount,
  onClearBlocks,
  className,
}: HandlePanelProps) {
  const [copied, setCopied] = useState(false);
  const blocking = blockCount > 0;

  function copyHandle() {
    if (!pseudonym) return;
    void navigator.clipboard?.writeText(pseudonym).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className={cn("rail-me", className)}>
      <i />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={copyHandle}
          title={pseudonym ? "Click to copy your handle" : undefined}
          className="rail-me-name block cursor-pointer border-0 bg-transparent p-0 text-left hover:underline"
        >
          {copied ? "copied handle" : pseudonym || "assigning a handle"}
        </button>
        <div className="rail-me-sub">yours, on this device</div>
      </div>
      <button
        type="button"
        className="rail-me-btn disabled:cursor-default disabled:opacity-45"
        disabled={!blocking}
        onClick={onClearBlocks}
        title={
          blocking
            ? "Show their messages again. Blocking only hides them on this device."
            : "Blocking hides someone's messages on this device."
        }
        aria-label={
          blocking
            ? `Show messages from the ${blockCount} handles you blocked`
            : "You have not blocked anyone"
        }
      >
        {blocking ? `blocks ${blockCount}` : "blocks"}
      </button>
    </div>
  );
}

export interface RoomLinksProps {
  active: RoomId;
  pulses?: Record<RoomId, RoomPulse> | null;
  liveOnline?: number;
  onNavigate?: () => void;
}

/** The room list, in the rail on wide screens and in the sheet on a phone. */
export function RoomLinks({
  active,
  pulses,
  liveOnline,
  onNavigate,
}: RoomLinksProps) {
  return (
    <>
      {ROOM_IDS.map((id) => {
        const isCurrent = id === active;
        const count = isCurrent
          ? (liveOnline ?? pulses?.[id]?.online ?? 0)
          : (pulses?.[id]?.online ?? 0);
        return (
          <Link
            key={id}
            to={`/room/${id}`}
            className={cn("rail-item", isCurrent && "active")}
            aria-current={isCurrent ? "page" : undefined}
            onClick={onNavigate}
          >
            <span className="rail-hash">#</span>
            <span className="min-w-0 flex-1 truncate">{id}</span>
            {count > 0 ? (
              <span className="border-line-2 bg-panel text-ok inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-sm)] border px-1.5 py-0.5 font-mono text-[10.5px] font-medium tabular-nums">
                <span className="bg-ok inline-block h-1.5 w-1.5" />
                {count}
              </span>
            ) : (
              <span className="text-ink-3 shrink-0 font-mono text-[10.5px] tabular-nums">
                —
              </span>
            )}
          </Link>
        );
      })}
    </>
  );
}

export interface RoomRailProps {
  pseudonym: string;
  blockCount: number;
  onClearBlocks: () => void;
  active: RoomId;
  pulses?: Record<RoomId, RoomPulse> | null;
  liveOnline?: number;
}

export function RoomRail({
  pseudonym,
  blockCount,
  onClearBlocks,
  active,
  pulses,
  liveOnline,
}: RoomRailProps) {
  const currentRoom = ROOMS[active];

  return (
    <nav className="rail" aria-label="Rooms">
      <div className="rail-scroll">
        <div className="rail-card">
          <div className="rail-card-head">
            <span>Rooms</span>
            <span>{ROOM_IDS.length} channels</span>
          </div>
          <div className="rail-card-body">
            <RoomLinks
              active={active}
              pulses={pulses}
              liveOnline={liveOnline}
            />
          </div>
        </div>

        <div className="rail-card">
          <div className="rail-card-head">
            <span>Active Room</span>
            <span className="text-brand">#{currentRoom.id}</span>
          </div>
          <div className="space-y-2 p-2.5 text-[12px]">
            <p className="text-ink-2 m-0 leading-relaxed">
              {currentRoom.subtitle}
            </p>
            <div className="border-line text-ink-3 flex items-center justify-between border-t pt-2 font-mono text-[11px]">
              <span>Retention</span>
              <span className="text-ink-2">48h auto-purge</span>
            </div>
          </div>
        </div>
      </div>

      <HandlePanel
        pseudonym={pseudonym}
        blockCount={blockCount}
        onClearBlocks={onClearBlocks}
      />
    </nav>
  );
}
