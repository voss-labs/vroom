import { cn } from "~/lib/utils";

import { ROOMS, ROOM_IDS, type RoomId } from "~/lib/rooms";
import { Link } from "react-router";

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
  const blocking = blockCount > 0;
  return (
    <div className={cn("rail-me", className)}>
      <i />
      <div className="min-w-0 flex-1">
        <div className="rail-me-name">{pseudonym || "assigning a handle"}</div>
        <div className="rail-me-sub">yours, permanently</div>
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

export interface RoomRailProps {
  pseudonym: string;
  blockCount: number;
  onClearBlocks: () => void;
  activeRoomId: RoomId;
}

export function RoomRail({
  pseudonym,
  blockCount,
  onClearBlocks,
  activeRoomId,
}: RoomRailProps) {
  return (
    <nav className="rail" aria-label="Rooms">
      <div className="rail-scroll">
        <div className="rail-label">Rooms</div>
        
        {ROOM_IDS.map((id) => (
          <Link
            key={id}
            to={`/room/${id}`}
            className={cn("rail-item", activeRoomId === id && "active")}
            aria-current={activeRoomId === id ? "page" : undefined}
          >
            <span className="rail-hash">#</span> {id}
          </Link>
        ))}
      </div>

      <HandlePanel
        pseudonym={pseudonym}
        blockCount={blockCount}
        onClearBlocks={onClearBlocks}
      />
    </nav>
  );
}
