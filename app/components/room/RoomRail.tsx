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
        const meta = ROOMS[id];
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
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">{id}</span>
                {count > 0 && (
                  <span className="text-ok flex shrink-0 items-center gap-1 font-mono text-[11px] font-normal tabular-nums">
                    <span className="bg-ok inline-block h-1.5 w-1.5" />
                    {count}
                  </span>
                )}
              </div>
              <div className="text-ink-3 truncate font-sans text-[11px] font-normal">
                {meta.subtitle}
              </div>
            </div>
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
  return (
    <nav className="rail" aria-label="Rooms">
      <div className="rail-scroll">
        <div className="rail-label">
          Rooms <span>{ROOM_IDS.length}</span>
        </div>
        <RoomLinks active={active} pulses={pulses} liveOnline={liveOnline} />
      </div>

      <HandlePanel
        pseudonym={pseudonym}
        blockCount={blockCount}
        onClearBlocks={onClearBlocks}
      />
    </nav>
  );
}
