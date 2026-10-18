import { Link, data } from "react-router";

import type { Route } from "./+types/mod";
import { ThemeToggle } from "~/components/ThemeToggle";
import { AccountTable } from "~/components/mod/AccountTable";
import { AuditList } from "~/components/mod/AuditList";
import { ReportTable } from "~/components/mod/ReportTable";
import { RoomSwitch } from "~/components/mod/RoomSwitch";
import { StatCards } from "~/components/mod/StatCards";
import { listAudit } from "~/db/queries/audit";
import { countSuspended, listAccounts } from "~/db/queries/members";
import {
  countOpenReports,
  countReports,
  listReports,
  REPORTS_PAGE_SIZE,
} from "~/db/queries/reports";
import {
  isModIntent,
  performModeration,
  type ModFields,
} from "~/lib/moderation.server";
import { isSameOrigin } from "~/lib/origin.server";
import { drainPolicyFlags } from "~/lib/policy.server";
import { ModerationError, requireModerator } from "~/lib/require-role.server";
import { readRooms } from "~/lib/room.server";
import { ROOMS } from "~/lib/rooms";

/**
 * The moderator console (VRIP-05). The navigation entry not rendering for a
 * student is presentation; `requireModerator` at the top of the loader and
 * again at the top of the action is the access control.
 *
 * The action is the endpoint that closes the room and suspends handles, so it
 * carries an explicit same-origin check rather than resting on the session
 * cookie's inherited sameSite default.
 */

/** What the action returns, as the fetchers in the components see it. */
export interface ModActionData {
  data?: {
    intent: string;
    email?: string;
    name?: string;
    killed?: boolean;
    at?: number;
    ok?: true;
  };
  error?: { code: string; message: string };
}

export function meta() {
  return [
    { title: "Moderation — V Rooms" },
    { name: "robots", content: "noindex" },
  ];
}

function pageParam(request: Request): number {
  const raw = Number(new URL(request.url).searchParams.get("page"));
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireModerator(request);
  const page = pageParam(request);

  // VRIP-09's bridge, awaited before the queue is read so a message the room
  // refused an hour ago is in this load rather than the next one. The result is
  // deliberately not rendered: an auto-flag surfaces as an ordinary report row,
  // and an unreachable object is already logged by `tryRoom` rather than being
  // one more number on a page read under time pressure.
  await drainPolicyFlags();

  // The live numbers are Durable Object reads across every room and degrade to
  // null. The queue is a Neon read and renders either way — a room that cannot
  // be reached is exactly when the reports still need looking at.
  const [reports, totalReports, accounts, audit, openReports, suspended, live] =
    await Promise.all([
      listReports(page),
      countReports(),
      listAccounts(),
      listAudit(100),
      countOpenReports(),
      countSuspended(),
      readRooms(),
    ]);

  // No email leaves this function; students have none to leak (VRIP-13).
  return {
    reports,
    accounts,
    audit,
    openReports,
    suspended,
    stats: live ? live.stats : null,
    roomState: live ? live.roomState : null,
    counts: live ? live.counts : null,
    perRoom: live ? (live.perRoom ?? null) : null,
    page,
    totalReports,
    pageCount: Math.max(1, Math.ceil(totalReports / REPORTS_PAGE_SIZE)),
  };
}

function text(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function action({ request }: Route.ActionArgs) {
  if (!isSameOrigin(request)) {
    return data<ModActionData>(
      {
        error: {
          code: "cross_origin",
          message: "Cross-origin requests are refused.",
        },
      },
      { status: 403 },
    );
  }

  // Re-checked on every action. There is no cached role and no client claim.
  const actor = await requireModerator(request);

  const form = await request.formData();
  const intent = form.get("intent");
  if (!isModIntent(intent)) {
    return data<ModActionData>(
      { error: { code: "bad_request", message: "Unknown action." } },
      { status: 400 },
    );
  }

  const fields: ModFields = {
    reportId: text(form.get("reportId")),
    memberId: text(form.get("memberId")),
    reason: text(form.get("reason")),
    killed: form.get("killed") === "true",
  };

  try {
    const result = await performModeration(
      { member: actor.member, kind: "console" },
      intent,
      fields,
    );
    return data<ModActionData>({ data: result });
  } catch (error) {
    if (error instanceof ModerationError) {
      return data<ModActionData>(
        { error: { code: error.code, message: error.message } },
        { status: error.status },
      );
    }
    // Anything else is a bug, and the error boundary should say so loudly.
    throw error;
  }
}

export default function ModConsole({ loaderData }: Route.ComponentProps) {
  const {
    reports,
    accounts,
    audit,
    openReports,
    suspended,
    stats,
    roomState,
    counts,
    perRoom,
  } = loaderData;
  const { page, pageCount, totalReports } = loaderData;

  return (
    <div className="app">
      <header className="topbar">
        <div className="wordmark">
          <i />V ROOMS <small>voss labs</small>
        </div>

        <nav className="tabs" aria-label="View">
          <Link className="tab" to="/room">
            Campus Live
          </Link>
          <Link className="tab" to="/mod" aria-current="page">
            Moderation
          </Link>
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          <ThemeToggle />
          {openReports > 0 && (
            <span className="tag tag-dead max-[540px]:hidden">
              {openReports} open {openReports === 1 ? "report" : "reports"}
            </span>
          )}
          <span className="tag max-[720px]:hidden">48h retention</span>
          <span className={stats ? "tag tag-live" : "tag"}>
            {stats ? (
              <>
                <span className="mark" />
                {stats.online}
                <span className="max-[400px]:hidden"> online</span>
              </>
            ) : (
              <span className="text-ink-3">unreachable</span>
            )}
          </span>
        </div>
      </header>

      <div className="admin">
        <div className="admin-inner">
          <div className="border-line-2 bg-panel flex flex-wrap items-start justify-between gap-3 rounded-[var(--r-card)] border p-4">
            <div>
              <div className="text-ink-3 mb-1 font-mono text-[11px] font-semibold tracking-[0.12em] uppercase">
                VOSS Safety Console · VRIP-05 / VRIP-13
              </div>
              <h1 className="text-[20px] font-semibold tracking-[-0.02em] text-balance sm:text-[22px]">
                Moderation
              </h1>
              <p className="text-ink-2 mt-1 max-w-[68ch] text-[13.5px] leading-[1.55]">
                Students hold device keys only — there is no name or email
                behind a handle. Room messages disappear after 48 hours, while
                reported snapshots and every moderator action are kept in the
                audit trail.
              </p>
            </div>
            <Link to="/room" className="btn btn-sm h-9 px-3 font-mono">
              Open #campus-live →
            </Link>
          </div>

          <StatCards
            openReports={openReports}
            suspended={suspended}
            online={stats ? stats.online : null}
            peakToday={stats ? stats.peakToday : null}
            messages={stats ? stats.total : null}
            since={stats ? stats.since : null}
          />

          <RoomSwitch
            killed={roomState ? roomState.killed : null}
            killedAt={roomState ? roomState.killedAt : null}
            killedBy={roomState ? roomState.killedBy : null}
          />

          {perRoom && perRoom.length > 0 ? (
            <section className="sec overflow-hidden" aria-label="Room activity">
              <div className="rail-card-head px-4 py-2.5">
                <span>Room Pulse · All Channels</span>
                <span>5 rooms · 48h window</span>
              </div>
              <div className="divide-line-2 grid grid-cols-1 divide-y sm:grid-cols-2 sm:divide-x sm:divide-y-0 lg:grid-cols-5">
                {perRoom.map((r) => {
                  const meta = ROOMS[r.roomId];
                  return (
                    <Link
                      key={r.roomId}
                      to={`/room/${r.roomId}`}
                      className="hover:bg-panel-2 flex flex-col justify-between gap-2 p-3.5 no-underline transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-ink font-mono text-[13px] font-semibold">
                          <span className="text-brand">#</span>
                          {r.roomId}
                        </span>
                        <span
                          className={
                            r.online > 0
                              ? "badge badge-ok px-1.5 py-0.5 font-mono text-[11px]"
                              : "badge px-1.5 py-0.5 font-mono text-[11px]"
                          }
                        >
                          {r.online} live
                        </span>
                      </div>
                      <div className="text-ink-3 flex items-center justify-between gap-2 font-mono text-[11px]">
                        <span className="truncate">{meta?.subtitle ?? ""}</span>
                        <span className="text-ink-2 shrink-0 tabular-nums">
                          {r.messages} msgs
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </section>
          ) : null}

          <ReportTable
            reports={reports}
            page={page}
            pageCount={pageCount}
            total={totalReports}
          />

          <AccountTable accounts={accounts} counts={counts} />

          <AuditList entries={audit} />
        </div>
      </div>
    </div>
  );
}
