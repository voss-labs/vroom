import { Link, data } from "react-router";

import type { Route } from "./+types/mod";
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
import { ModerationError, requireModerator } from "~/lib/require-role.server";
import { tryRoom } from "~/lib/room.server";

/**
 * The moderator console (VRIP-05). The navigation entry not rendering for a
 * student is presentation; `requireModerator` at the top of the loader and
 * again at the top of the action is the access control.
 *
 * The action is the endpoint that closes the room and reveals identities, so it
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

  // The three live numbers are Durable Object reads and degrade to null. The
  // queue is a Neon read and renders either way — a room that cannot be reached
  // is exactly when the reports still need looking at.
  const [
    reports,
    totalReports,
    accounts,
    audit,
    openReports,
    suspended,
    stats,
    roomState,
    counts,
  ] = await Promise.all([
    listReports(page),
    countReports(),
    listAccounts(),
    listAudit(100),
    countOpenReports(),
    countSuspended(),
    tryRoom("campus-live", (room) => room.stats()),
    tryRoom("campus-live", (room) => room.getRoomState()),
    tryRoom("campus-live", (room) => room.countsByPseudonym()),
  ]);

  // No email leaves this function. `reveal` is a POST and nothing else (VRIP-08).
  return {
    reports,
    accounts,
    audit,
    openReports,
    suspended,
    stats,
    roomState,
    counts,
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

        <div className="ml-auto flex items-center gap-[9px]">
          <span className={stats ? "tag tag-live" : "tag"}>
            {stats ? (
              <>
                <span className="mark" />
                {stats.online} online
              </>
            ) : (
              <span className="text-ink-3">room unreachable</span>
            )}
          </span>
        </div>
      </header>

      <div className="admin">
        <div className="admin-inner">
          <div>
            <h1 className="text-[22px] font-semibold tracking-[-0.02em] text-balance">
              Moderation
            </h1>
            <p className="text-ink-2 mt-1.5 max-w-[68ch] text-[14px] leading-[1.6]">
              Students see handles only. You can resolve a handle to a real
              account, and every time you do it is recorded against the message
              that justified it.
            </p>
          </div>

          <StatCards
            openReports={openReports}
            suspended={suspended}
            online={stats ? stats.online : null}
            peakToday={stats ? stats.peakToday : null}
            messages={stats ? stats.total : null}
            since={stats ? stats.since : null}
          />

          <RoomSwitch killed={roomState ? roomState.killed : null} />

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
