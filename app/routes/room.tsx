import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { data } from "react-router";
import type { Route } from "./+types/room";
import { Composer, type ComposerDraft } from "~/components/room/Composer";
import { ConnectionState } from "~/components/room/ConnectionState";
import { MemberRail } from "~/components/room/MemberRail";
import { MemberSheet } from "~/components/room/MemberSheet";
import { MessageList } from "~/components/room/MessageList";
import { RoomRail } from "~/components/room/RoomRail";
import { TopBar } from "~/components/room/TopBar";
import { ensurePseudonym } from "~/lib/membership.server";
import { requireSession } from "~/lib/require-role.server";
import { reportFailureMessage, submitMessageReport } from "~/lib/report.client";
import { readRoomPulses } from "~/lib/room.server";
import {
  loadBlocked,
  RoomConnection,
  saveBlocked,
  type ConnectionState as SocketState,
  type LogEntry,
} from "~/lib/room-client";
import { ROOMS, isRoomId } from "~/lib/rooms";
import {
  EPHEMERAL_TTL_MS,
  MESSAGE_TTL_MS,
  type DeletedBy,
  type EphemeralMsg,
  type Msg,
  type SystemTone,
} from "../../workers/protocol";
export const headers = () => ({ "Cache-Control": "private, no-store" });
export function meta({ loaderData }: Route.MetaArgs) {
  if (!loaderData) return [{ title: "V Rooms" }];
  return [
    { title: `${loaderData.room.name} - V Rooms` },
    { name: "description", content: loaderData.room.subtitle },
  ];
}
export async function loader({ request, params }: Route.LoaderArgs) {
  const actor = await requireSession(request);
  if (!isRoomId(params.roomId)) throw data("No such room.", { status: 404 });
  const [member, pulses] = await Promise.all([
    ensurePseudonym(actor.member),
    readRoomPulses(),
  ]);
  return data(
    {
      pseudonym: member.pseudonym ?? "",
      room: ROOMS[params.roomId],
      pulses,
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
const EMPTY: ReadonlySet<string> = new Set();
const NONE_DELETED: ReadonlyMap<string, DeletedBy> = new Map();
const toEntry = (m: Msg): LogEntry => ({
  kind: "msg",
  key: `m-${m.id}`,
  msg: m,
});
const tempKey = (id: string): string => `t-${id}`;
export default function RoomRoute({ loaderData }: Route.ComponentProps) {
  return <RoomView key={loaderData.room.id} loaderData={loaderData} />;
}

function RoomView({ loaderData }: Pick<Route.ComponentProps, "loaderData">) {
  const room = loaderData.room;
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [pseudonym, setPseudonym] = useState(loaderData.pseudonym);
  const [status, setStatus] = useState<SocketState>("connecting");
  const [killed, setKilled] = useState(false);
  const [members, setMembers] = useState<string[]>([]);
  const [online, setOnline] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(EMPTY);
  const [deleted, setDeleted] =
    useState<ReadonlyMap<string, DeletedBy>>(NONE_DELETED);
  const [reported, setReported] = useState<ReadonlySet<string>>(EMPTY);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [draft, setDraft] = useState<ComposerDraft | null>(null);
  const draftSeq = useRef(0);
  const handleStarter = useCallback((text: string) => {
    draftSeq.current += 1;
    setDraft({ text, seq: draftSeq.current });
  }, []);
  const handleMention = useCallback(
    (who: string) => handleStarter(`@${who} `),
    [handleStarter],
  );

  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1041px)");
    const sync = () => {
      if (wide.matches) setSheetOpen(false);
    };
    sync();
    wide.addEventListener("change", sync);
    return () => wide.removeEventListener("change", sync);
  }, []);

  const connection = useRef<RoomConnection | null>(null);
  const blockedRef = useRef<ReadonlySet<string>>(EMPTY);
  const systemSeq = useRef(0);
  const expiries = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const expire = useCallback((msg: EphemeralMsg) => {
    const key = tempKey(msg.id);
    const timer = setTimeout(() => {
      expiries.current.delete(key);
      setEntries((prev) => prev.filter((entry) => entry.key !== key));
    }, EPHEMERAL_TTL_MS);
    expiries.current.set(key, timer);
  }, []);

  useEffect(() => {
    const timers = expiries.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    const sweep = setInterval(() => {
      const cutoff = Date.now() - MESSAGE_TTL_MS;
      setEntries((prev) => {
        if (!prev.some((e) => e.kind === "msg" && e.msg.at <= cutoff))
          return prev;
        return prev.filter((e) => e.kind !== "msg" || e.msg.at > cutoff);
      });
    }, 30_000);
    return () => clearInterval(sweep);
  }, []);

  const pushSystem = useCallback((tone: SystemTone, text: string) => {
    systemSeq.current += 1;
    const key = `sys-${systemSeq.current}`;
    setEntries((prev) => [...prev, { kind: "system", key, tone, text }]);
  }, []);

  useEffect(() => {
    const socket = new RoomConnection(room.id, {
      onState: setStatus,

      onReady(ready) {
        systemSeq.current += 1;
        setPseudonym(ready.pseudonym);
        setKilled(ready.killed);
        setHasMore(ready.hasMore);
        setLoadingMore(false);
        setDeleted(NONE_DELETED);
        for (const timer of expiries.current.values()) clearTimeout(timer);
        expiries.current.clear();
        setEntries([
          ...ready.messages.map(toEntry),
          {
            kind: "system",
            key: `sys-${systemSeq.current}`,
            tone: "join",
            text: `You joined as ${ready.pseudonym}. Nobody here can see your name.`,
          },
        ]);
      },

      onMessage(msg) {
        setEntries((prev) => [...prev, toEntry(msg)]);
      },

      onEphemeral(msg) {
        setEntries((prev) => [
          ...prev,
          {
            kind: "temp",
            key: tempKey(msg.id),
            msg,
            expiresAt: Date.now() + EPHEMERAL_TTL_MS,
          },
        ]);
        expire(msg);
      },

      onDeleted(id, by) {
        setDeleted((prev) => new Map(prev).set(id, by));
      },

      onPresence(count, list) {
        setOnline(count);
        setMembers(list);
      },

      onRoom: setKilled,
      onSystem: pushSystem,

      onHistory(messages, more) {
        setLoadingMore(false);
        setHasMore(more);
        if (messages.length > 0)
          setEntries((prev) => [...messages.map(toEntry), ...prev]);
      },

      onError(code, message, retryAfter) {
        setLoadingMore(false);
        const text =
          code === "rate_limited" && retryAfter
            ? `${message} Try again in ${retryAfter}s.`
            : message;
        pushSystem("warn", text);
      },
    });

    connection.current = socket;
    socket.start();
    return () => {
      socket.stop();
      connection.current = null;
    };
  }, [expire, pushSystem, room.id]);

  const applyBlocked = useCallback((next: Set<string>, persist: boolean) => {
    blockedRef.current = next;
    setBlocked(next);
    if (persist) saveBlocked(next);
  }, []);

  useEffect(() => {
    applyBlocked(loadBlocked(), false);
  }, [applyBlocked]);

  const handleBlock = useCallback(
    (who: string) => {
      const next = new Set(blockedRef.current);
      next.add(who);
      applyBlocked(next, true);
    },
    [applyBlocked],
  );

  const handleClearBlocks = useCallback(
    () => applyBlocked(new Set(), true),
    [applyBlocked],
  );

  const handleReport = useCallback(
    async (msg: Msg) => {
      setReported((prev) => new Set(prev).add(msg.id));
      try {
        await submitMessageReport(msg.id, room.id);
        pushSystem(
          "join",
          "Report sent. A moderator reads every one of these.",
        );
      } catch (error) {
        setReported((prev) => {
          const next = new Set(prev);
          next.delete(msg.id);
          return next;
        });
        pushSystem("warn", reportFailureMessage(error));
      }
    },
    [pushSystem, room.id],
  );

  const oldestSeq = useMemo(() => {
    for (const entry of entries) if (entry.kind === "msg") return entry.msg.seq;
    return null;
  }, [entries]);

  const handleBackfill = useCallback(() => {
    if (loadingMore || !hasMore || oldestSeq === null) return;
    setLoadingMore(true);
    if (!connection.current?.requestHistory(oldestSeq)) setLoadingMore(false);
  }, [hasMore, loadingMore, oldestSeq]);

  const handleWithdraw = useCallback(
    (msg: Msg) => {
      const sent = connection.current?.withdraw(msg.id) ?? false;
      if (!sent)
        pushSystem(
          "warn",
          "Not connected, so that was not withdrawn. Try again shortly.",
        );
    },
    [pushSystem],
  );

  const handleSend = useCallback(
    (body: string, confirmed: boolean) => {
      const sent = connection.current?.send(body, confirmed) ?? false;
      if (!sent)
        pushSystem(
          "warn",
          "Not connected, so that did not send. Try again shortly.",
        );
      return sent;
    },
    [pushSystem],
  );

  const roster = useMemo(() => {
    return [...members].sort((a, b) => {
      if (a === pseudonym) return -1;
      if (b === pseudonym) return 1;
      return a.localeCompare(b);
    });
  }, [members, pseudonym]);

  return (
    <div className="app">
      <TopBar
        room={room}
        online={online}
        killed={killed}
        onOpenMembers={() => setSheetOpen(true)}
      />

      <div className="room">
        <RoomRail
          pseudonym={pseudonym}
          blockCount={blocked.size}
          onClearBlocks={handleClearBlocks}
          active={room.id}
          pulses={loaderData.pulses}
          liveOnline={online}
        />

        <main className="chat">
          <div className="chat-head">
            <span className="chat-title">#{room.id}</span>
            <span className="chat-sub">{room.subtitle}</span>
            <span
              className="row-tag max-[540px]:hidden"
              title="Messages disappear after 48 hours and are deleted from the room database"
            >
              48h window
            </span>
            <span className="chat-state" aria-live="polite">
              <ConnectionState state={status} killed={killed} />
            </span>
          </div>

          <MessageList
            entries={entries}
            self={pseudonym}
            blocked={blocked}
            deleted={deleted}
            reported={reported}
            hasMore={hasMore}
            loadingMore={loadingMore}
            joining={status === "connecting" || status === "reconnecting"}
            onBackfill={handleBackfill}
            onReport={handleReport}
            onBlock={handleBlock}
            onWithdraw={handleWithdraw}
            onMention={handleMention}
            onStarter={handleStarter}
            room={room}
          />

          <Composer
            killed={killed}
            connected={status === "open"}
            onSend={handleSend}
            room={room}
            draft={draft}
          />
        </main>

        <MemberRail
          members={roster}
          self={pseudonym}
          onMention={handleMention}
        />
      </div>

      <MemberSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        active={room.id}
        members={roster}
        self={pseudonym}
        blockCount={blocked.size}
        onClearBlocks={handleClearBlocks}
        onMention={handleMention}
        pulses={loaderData.pulses}
        liveOnline={online}
      />
    </div>
  );
}
