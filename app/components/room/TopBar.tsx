import { Link } from "react-router";

import type { RoomMeta } from "~/lib/rooms";
import { cn } from "~/lib/utils";

export interface TopBarProps {
  room: RoomMeta;
  online: number;
  killed: boolean;
  isModerator: boolean;
  /** Below 1040px the count becomes the button that opens the member sheet. */
  onOpenMembers: () => void;
}

/**
 * The wordmark, the view tabs and the live count. Split out of `room.tsx` when
 * VRIP-11 pushed that file past its 400-line budget: it is the one block in the
 * route that reads no socket state of its own.
 */
export function TopBar({
  room,
  online,
  killed,
  isModerator,
  onOpenMembers,
}: TopBarProps) {
  const pill = (
    <>
      <span className={cn("mark", killed && "mark-dead")} />
      {online} online
    </>
  );

  return (
    <header className="topbar">
      <div className="wordmark">
        <i />V ROOMS <small>voss labs</small>
      </div>

      <nav className="tabs" aria-label="View">
        <Link to={`/room/${room.id}`} className="tab" aria-current="page">
          {room.name}
        </Link>
        {isModerator ? (
          <Link to="/mod" className="tab">
            Moderation
          </Link>
        ) : null}
      </nav>

      <div className="ml-auto flex items-center gap-[9px]">
        <span
          className={cn(
            "tag [@media(max-width:1040px)]:hidden",
            killed ? "tag-dead" : "tag-live",
          )}
        >
          {pill}
        </span>
        <button
          type="button"
          className={cn(
            "tag hidden min-h-11 [@media(max-width:1040px)]:inline-flex",
            killed ? "tag-dead" : "tag-live",
          )}
          aria-haspopup="dialog"
          aria-label={`${online} online. Open the rooms and the member list.`}
          onClick={onOpenMembers}
        >
          <span className={cn("mark", killed && "mark-dead")} />
          <span>Rooms · {online} online</span>
        </button>
      </div>
    </header>
  );
}
