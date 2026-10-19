import { Link } from "react-router";

import { ThemeToggle } from "~/components/ThemeToggle";
import { ROOM_IDS, type RoomMeta } from "~/lib/rooms";
import { cn } from "~/lib/utils";

export interface TopBarProps {
  room: RoomMeta;
  online: number;
  killed: boolean;
  /** Below 1040px the count becomes the button that opens the member sheet. */
  onOpenMembers: () => void;
}

/**
 * The wordmark, the view tabs and the live count. Split out of `room.tsx` when
 * VRIP-11 pushed that file past its 400-line budget: it is the one block in the
 * route that reads no socket state of its own.
 */
export function TopBar({ room, online, killed, onOpenMembers }: TopBarProps) {
  const pill = (
    <>
      <span className={cn("mark", killed && "mark-dead")} />
      {online} online
    </>
  );

  return (
    <>
      <header className="topbar">
        <div className="wordmark">
          <i />V ROOMS <small>voss labs</small>
        </div>

        <nav className="tabs" aria-label="View">
          <Link to={`/room/${room.id}`} className="tab" aria-current="page">
            {room.name}
          </Link>
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          <ThemeToggle />
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
              "tag hidden min-h-9 cursor-pointer [@media(max-width:1040px)]:inline-flex",
              killed ? "tag-dead" : "tag-live",
            )}
            aria-haspopup="dialog"
            aria-label={`${online} online. Open the rooms and the member list.`}
            onClick={onOpenMembers}
          >
            <span className={cn("mark", killed && "mark-dead")} />
            <span>
              <span className="max-[420px]:hidden">Rooms · </span>
              {online}
              <span className="max-[360px]:hidden"> online</span>
            </span>
          </button>
        </div>
      </header>

      <nav
        aria-label="Quick room switcher"
        className="border-line-2 bg-panel hidden shrink-0 [scrollbar-width:none] items-center gap-1.5 overflow-x-auto border-b px-3 py-1.5 max-[720px]:flex [&::-webkit-scrollbar]:hidden"
      >
        {ROOM_IDS.map((id) => {
          const active = id === room.id;
          return (
            <Link
              key={id}
              to={`/room/${id}`}
              aria-current={active ? "page" : undefined}
              className={cn(
                "inline-flex min-h-8 shrink-0 items-center gap-1 rounded-[var(--r-ctl)] border px-2.5 py-1 font-mono text-[12px] no-underline transition-colors",
                active
                  ? "border-brand bg-raised text-ink font-semibold"
                  : "border-line-2 bg-panel-2 text-ink-2 hover:text-ink",
              )}
            >
              <span className={active ? "text-brand" : "text-ink-3"}>#</span>
              {id}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
