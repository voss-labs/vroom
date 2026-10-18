import { useEffect, useRef, type MouseEvent } from "react";

import type { RoomPulse } from "~/lib/room.server";
import type { RoomId } from "~/lib/rooms";
import { MemberList } from "./MemberRail";
import { HandlePanel, RoomLinks } from "./RoomRail";

/**
 * Below 1040px the member rail is gone and below 720px so is the room rail,
 * which left a phone with no way to change room, see who is online or undo a
 * block. The sheet is that surface. A modal <dialog> because it already traps
 * focus, closes on Escape and paints its own backdrop.
 */
const SHEET_CSS = `
.vsheet {
  inset: 0;
  width: 100%;
  max-width: 100%;
  max-height: 82dvh;
  margin: auto 0 0;
  padding: 0;
  flex-direction: column;
  color: var(--color-ink);
  background: var(--color-panel);
  border: 1px solid var(--color-line-2);
  border-bottom: 0;
  border-radius: var(--r-card) var(--r-card) 0 0;
  overflow: hidden;
}
/* An author "display" declaration beats the UA rule that hides a closed dialog,
   so the sheet must only take a display value while it is actually open —
   otherwise it renders in flow on every screen and sits over the composer. */
.vsheet:not([open]) { display: none; }
.vsheet[open] { display: flex; }
.vsheet::backdrop { background: rgba(0, 0, 0, 0.62); }
@keyframes vsheet-rise {
  from { transform: translateY(16px); opacity: 0.4; }
  to { transform: none; opacity: 1; }
}
.vsheet[open] { animation: vsheet-rise 150ms ease-out; }
@media (prefers-reduced-motion: reduce) { .vsheet[open] { animation: none; } }
`;

export interface MemberSheetProps {
  open: boolean;
  onClose: () => void;
  active: RoomId;
  members: string[];
  self: string;
  blockCount: number;
  onClearBlocks: () => void;
  pulses?: Record<RoomId, RoomPulse> | null;
  liveOnline?: number;
  onMention?: (who: string) => void;
}

export function MemberSheet({
  open,
  onClose,
  active,
  members,
  self,
  blockCount,
  onClearBlocks,
  pulses,
  liveOnline,
  onMention,
}: MemberSheetProps) {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // A click on the backdrop is reported against the dialog element itself.
  function onBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <dialog
      ref={ref}
      className="vsheet"
      aria-label="Rooms and who is online"
      onClose={onClose}
      onClick={onBackdrop}
    >
      <style>{SHEET_CSS}</style>

      <div className="border-line-2 flex flex-none items-center gap-2 border-b px-2">
        <div className="rail-label flex-1">
          <span className="rail-hash">#</span> {active}
        </div>
        <button
          type="button"
          className="btn btn-sm min-h-11 px-4"
          onClick={onClose}
        >
          close
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        <div className="rail-label">Rooms</div>
        <RoomLinks
          active={active}
          pulses={pulses}
          liveOnline={liveOnline}
          onNavigate={onClose}
        />
        <div className="rail-label">
          Online <span>{members.length}</span>
        </div>
        <MemberList
          members={members}
          self={self}
          onMention={
            onMention
              ? (who) => {
                  onMention(who);
                  onClose();
                }
              : undefined
          }
        />
      </div>

      <HandlePanel
        pseudonym={self}
        blockCount={blockCount}
        onClearBlocks={onClearBlocks}
        className="[&_.rail-me-btn]:min-h-11 [&_.rail-me-btn]:px-4"
      />
    </dialog>
  );
}
