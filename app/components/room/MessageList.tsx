import { useLayoutEffect, useRef, useState } from "react";

import type { DeletedBy, Msg } from "../../../workers/protocol";
import type { LogEntry } from "~/lib/room-client";
import type { RoomMeta } from "~/lib/rooms";
import { EphemeralRow } from "./EphemeralRow";
import { MessageRow } from "./MessageRow";
import { SystemLine } from "./SystemLine";

/** How close to an edge counts as "at" it. */
const NEAR_BOTTOM = 80;
const NEAR_TOP = 120;

export interface MessageListProps {
  entries: LogEntry[];
  self: string;
  blocked: ReadonlySet<string>;
  /** Withdrawn or removed, by id. Absent means the message is still in the room. */
  deleted: ReadonlyMap<string, DeletedBy>;
  reported: ReadonlySet<string>;
  hasMore: boolean;
  loadingMore: boolean;
  joining: boolean;
  onBackfill: () => void;
  onReport: (msg: Msg) => void;
  onBlock: (who: string) => void;
  onWithdraw: (msg: Msg) => void;
  onMention?: (who: string) => void;
  onStarter?: (text: string) => void;
  room: RoomMeta;
}

/**
 * The log renders incrementally. The prototype rebuilt every row on every
 * change, which is fine against sixteen fake messages and unusable against a
 * fully retained history, so entries carry stable keys and the rows are
 * memoised: appending one message touches one DOM node.
 */
export function MessageList({
  entries,
  self,
  blocked,
  deleted,
  reported,
  hasMore,
  loadingMore,
  joining,
  onBackfill,
  onReport,
  onBlock,
  onWithdraw,
  onMention,
  onStarter,
  room,
}: MessageListProps) {
  const logRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const geometry = useRef({ height: 0, top: 0 });
  const previous = useRef({ first: "", last: "", length: 0 });

  // Read during render, which runs before React commits the new rows, so this
  // is the pre-update geometry the backfill restore below needs.
  const node = logRef.current;
  if (node)
    geometry.current = { height: node.scrollHeight, top: node.scrollTop };

  useLayoutEffect(() => {
    const log = logRef.current;
    if (!log) return;

    const first = entries[0]?.key ?? "";
    const last = entries[entries.length - 1]?.key ?? "";
    const prev = previous.current;
    // A backfill changes the head and leaves the tail alone. Anything else that
    // changes the head (a reconnect replacing the log) also changes the tail.
    const prepended =
      prev.length > 0 &&
      entries.length > prev.length &&
      first !== prev.first &&
      last === prev.last;
    previous.current = { first, last, length: entries.length };

    if (prepended) {
      // Hold the reader still: the page that just arrived above them must not
      // shove their position down by its own height. `.log` sets
      // overflow-anchor: none so the browser does not fight this.
      log.scrollTop =
        geometry.current.top + (log.scrollHeight - geometry.current.height);
      return;
    }
    if (atBottom) log.scrollTop = log.scrollHeight;
  }, [entries, atBottom]);

  function handleScroll() {
    const log = logRef.current;
    if (!log) return;
    const distance = log.scrollHeight - log.scrollTop - log.clientHeight;
    setAtBottom(distance <= NEAR_BOTTOM);
    if (log.scrollTop <= NEAR_TOP && hasMore && !loadingMore) onBackfill();
  }

  function jumpToLatest() {
    const log = logRef.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
    setAtBottom(true);
  }

  // An ephemeral message counts: the room is not empty while one is on screen.
  const hasMessages = entries.some((entry) => entry.kind !== "system");

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={logRef}
        className="log"
        role="log"
        aria-live="polite"
        aria-label={`${room.name} messages`}
        onScroll={handleScroll}
      >
        {loadingMore ? (
          <div className="sys">loading earlier messages</div>
        ) : null}
        {!loadingMore && !hasMore && hasMessages ? (
          <div className="sys">
            this is the beginning of {room.name} (last 48 hours)
          </div>
        ) : null}

        {entries.map((entry) => {
          if (entry.kind === "msg") {
            return (
              <MessageRow
                key={entry.key}
                msg={entry.msg}
                self={self}
                blocked={blocked.has(entry.msg.who)}
                deleted={deleted.get(entry.msg.id) ?? null}
                reported={reported.has(entry.msg.id)}
                onReport={onReport}
                onBlock={onBlock}
                onWithdraw={onWithdraw}
                onMention={onMention}
              />
            );
          }
          if (entry.kind === "temp") {
            return (
              <EphemeralRow
                key={entry.key}
                msg={entry.msg}
                expiresAt={entry.expiresAt}
                self={self}
                blocked={blocked.has(entry.msg.who)}
                onBlock={onBlock}
              />
            );
          }
          return (
            <SystemLine key={entry.key} tone={entry.tone} text={entry.text} />
          );
        })}

        {joining && !hasMessages ? (
          <div className="empty">joining {room.name}</div>
        ) : null}
        {!joining && !hasMessages ? (
          <div className="empty mx-auto max-w-[460px]">
            <p className="text-ink-2 m-0 font-medium">
              Nobody has said anything in the last 48 hours. You could be first.
            </p>
            <p className="mt-1 mb-0">{room.empty}</p>
            {onStarter && room.starters.length > 0 ? (
              <div className="mt-4 flex flex-wrap justify-center gap-1.5">
                {room.starters.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => onStarter(prompt)}
                    className="border-line-2 bg-panel-2 text-ink-2 hover:border-brand/50 hover:bg-raised hover:text-ink cursor-pointer rounded-[var(--r-ctl)] border px-2.5 py-1.5 text-left text-[12px] transition-colors"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {!atBottom ? (
        <button
          type="button"
          className="btn btn-sm absolute right-4 bottom-3 z-10 [@media(max-width:720px)]:h-11"
          onClick={jumpToLatest}
        >
          jump to latest
        </button>
      ) : null}
    </div>
  );
}
