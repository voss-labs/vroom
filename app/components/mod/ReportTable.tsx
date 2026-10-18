import { useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";

import {
  CBX,
  CBX_HIT,
  COL_A,
  COL_X,
  DOTS,
  ERROR_NOTE,
  RowMenu,
  SORTBTN,
  TBL_FOOT,
  type MenuItem,
} from "./RowMenu";
import { auditTime, cn, handleColour } from "~/lib/utils";
import type { ModActionData } from "~/routes/mod";

/**
 * The report queue: filter, column toggle, checkbox selection, sortable author,
 * row overflow menu and selection footer. No identity column exists (VRIP-13).
 */

export interface ReportRow {
  id: string;
  messageId: string;
  snapshot: string;
  reason: string | null;
  handle: string | null;
  reportedMemberId: string;
  roomId?: string;
  status: string;
  createdAt: string | Date;
}

type Column = "room" | "author";
type StatusFilter = "all" | "open" | "closed";

export interface ReportTableProps {
  reports: ReportRow[];
  page: number;
  pageCount: number;
  total: number;
}

export function ReportTable({
  reports,
  page,
  pageCount,
  total,
}: ReportTableProps) {
  const fetcher = useFetcher<ModActionData>();
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sortDir, setSortDir] = useState<0 | 1 | -1>(0);
  const [hidden, setHidden] = useState<Set<Column>>(new Set());

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const matched = reports.filter((r) => {
      if (statusFilter === "open" && r.status !== "open") return false;
      if (statusFilter === "closed" && r.status === "open") return false;
      if (!q) return true;
      const hay = `${r.snapshot} ${r.handle ?? ""} ${r.roomId ?? ""} ${r.reason ?? ""}`;
      return hay.toLowerCase().includes(q);
    });
    if (sortDir === 0) return matched;
    return [...matched].sort(
      (a, b) => (a.handle ?? "").localeCompare(b.handle ?? "") * sortDir,
    );
  }, [reports, filter, statusFilter, sortDir]);

  const busyId =
    fetcher.state !== "idle"
      ? String(fetcher.formData?.get("reportId") ?? "")
      : "";
  const act = (
    intent: string,
    reportId: string,
    extra?: Record<string, string>,
  ) => fetcher.submit({ intent, reportId, ...extra }, { method: "post" });

  function toggleSet<T>(
    setter: React.Dispatch<React.SetStateAction<Set<T>>>,
    key: NoInfer<T>,
  ) {
    setter((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  function menuFor(report: ReportRow): MenuItem[] {
    const done = report.status !== "open";
    const isAutoFlag = report.messageId.startsWith("flag:");
    const label = isAutoFlag
      ? `Policy flag ${report.messageId}`
      : `Report on message ${report.messageId.slice(0, 8)}`;
    return [
      { kind: "label", text: label },
      {
        text: "Delete message",
        danger: true,
        disabled: done || isAutoFlag,
        onSelect: () => act("delete_message", report.id),
      },
      {
        text: `Suspend ${report.handle ?? "this account"}`,
        danger: true,
        disabled: done || !report.handle,
        onSelect: () =>
          act("suspend", report.id, { memberId: report.reportedMemberId }),
      },
      { kind: "sep" },
      {
        text: "Dismiss report",
        disabled: done,
        onSelect: () => act("dismiss_report", report.id),
      },
    ];
  }

  return (
    <section className="sec overflow-hidden">
      <div className="rail-card-head px-4 py-2.5">
        <span>Moderation Queue · Reports</span>
        <span>{total} total</span>
      </div>
      <div className="sec-head">
        <h2>Reports</h2>
        <p>
          Handles are anonymous to VOSS too. Delete the message, suspend the
          handle across all rooms, or dismiss the report.
        </p>
      </div>

      <div className="toolbar">
        <input
          className="inp"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter messages, handles, rooms..."
          aria-label="Filter reports"
        />
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Filter by status"
        >
          {(["all", "open", "closed"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setStatusFilter(mode)}
              className={cn(
                "btn btn-sm capitalize",
                statusFilter === mode && "border-brand text-ink bg-raised",
              )}
            >
              {mode}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <RowMenu
            label="Toggle columns"
            className="btn h-11"
            items={[
              { kind: "label", text: "Toggle columns" },
              {
                text: "Room",
                tick: !hidden.has("room"),
                keepOpen: true,
                onSelect: () => toggleSet(setHidden, "room"),
              },
              {
                text: "Author",
                tick: !hidden.has("author"),
                keepOpen: true,
                onSelect: () => toggleSet(setHidden, "author"),
              },
            ]}
          >
            Columns <span aria-hidden="true">▾</span>
          </RowMenu>
        </div>
      </div>

      {fetcher.data?.error && (
        <p role="alert" className={`${ERROR_NOTE} mx-[18px] mb-3`}>
          {fetcher.data.error.code}: {fetcher.data.error.message}
        </p>
      )}

      <div className="tbl-wrap">
        <div className="tbl-box">
          <table className="tbl">
            <thead>
              <tr>
                <th className={COL_X}>
                  <label className={CBX_HIT}>
                    <input
                      type="checkbox"
                      className={CBX}
                      checked={allSelected}
                      aria-label="Select all reports"
                      onChange={(event) =>
                        setSelected(
                          event.target.checked
                            ? new Set(rows.map((row) => row.id))
                            : new Set(),
                        )
                      }
                    />
                  </label>
                </th>
                <th>Reported message</th>
                {!hidden.has("room") && (
                  <th className="max-[640px]:hidden">Room</th>
                )}
                {!hidden.has("author") && (
                  <th
                    className="max-[640px]:hidden"
                    aria-sort={
                      sortDir === 0
                        ? "none"
                        : sortDir === 1
                          ? "ascending"
                          : "descending"
                    }
                  >
                    <button
                      type="button"
                      className={SORTBTN}
                      onClick={() =>
                        setSortDir((current) => (current === 1 ? -1 : 1))
                      }
                    >
                      Author
                      <i
                        className="text-ink-3 text-[11px] not-italic"
                        aria-hidden="true"
                      >
                        {sortDir === 0 ? "↕" : sortDir === 1 ? "↑" : "↓"}
                      </i>
                    </button>
                  </th>
                )}
                <th className={COL_A}>
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((report) => {
                const done = report.status !== "open";
                const busy = busyId === report.id;
                const isAutoFlag = report.messageId.startsWith("flag:");
                const authorColor = report.handle
                  ? handleColour(report.handle)
                  : undefined;
                const roomName = report.roomId ?? "campus-live";
                const authorName = report.handle ?? "no handle";
                const summary = isAutoFlag
                  ? `Auto-flag · ${report.reason ?? "policy match"}`
                  : `Message ${report.messageId.slice(0, 8)} · ${report.reason ?? "reported by a student"}`;
                return (
                  <tr
                    key={report.id}
                    className={done ? "gone" : undefined}
                    aria-busy={busy}
                  >
                    <td className={COL_X}>
                      <label className={CBX_HIT}>
                        <input
                          type="checkbox"
                          className={CBX}
                          checked={selected.has(report.id)}
                          aria-label={`Select report on message ${report.messageId.slice(0, 8)}`}
                          onChange={() => toggleSet(setSelected, report.id)}
                        />
                      </label>
                    </td>
                    <td>
                      <div className="cell-msg">{report.snapshot}</div>
                      <div className="cell-sub flex flex-wrap items-center gap-1.5">
                        <span className="text-ink-2 hidden font-mono text-[11.5px] font-semibold max-[640px]:inline">
                          #{roomName} ·{" "}
                          <span style={{ color: authorColor }}>
                            {authorName}
                          </span>{" "}
                          ·
                        </span>
                        <span>{summary}</span>
                        <span>· {auditTime(report.createdAt)}</span>
                        {done && (
                          <span className="badge py-0 text-[11px]">
                            {report.status}
                          </span>
                        )}
                        {busy && <span>· working</span>}
                      </div>
                    </td>
                    {!hidden.has("room") && (
                      <td className="text-ink-2 font-mono text-xs whitespace-nowrap max-[640px]:hidden">
                        #{roomName}
                      </td>
                    )}
                    {!hidden.has("author") && (
                      <td
                        className="cell-handle max-[640px]:hidden"
                        style={{ color: authorColor }}
                      >
                        {authorName}
                      </td>
                    )}
                    <td className="w-[1%] whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        {!done && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => act("dismiss_report", report.id)}
                            className="btn btn-sm max-[760px]:hidden"
                          >
                            Dismiss
                          </button>
                        )}
                        <RowMenu
                          label="Actions for this report"
                          className={DOTS}
                          disabled={busy}
                          items={menuFor(report)}
                        >
                          <span aria-hidden="true">⋯</span>
                        </RowMenu>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="empty">
              {reports.length === 0
                ? "No reports yet."
                : "No reports match that filter."}
            </div>
          )}
        </div>
      </div>

      <div className={TBL_FOOT}>
        <span>
          {`${selected.size} of ${rows.length} row(s) selected. Page ${page + 1} of ${pageCount}, ${total} report(s) in total.`}
          {filter.trim() || statusFilter !== "all"
            ? " Filtering this page only."
            : ""}
        </span>
        <div className="ml-auto flex gap-2">
          {page > 0 ? (
            <Link
              className="btn btn-sm"
              to={`?page=${page - 1}`}
              preventScrollReset
            >
              Previous
            </Link>
          ) : (
            <button type="button" className="btn btn-sm" disabled>
              Previous
            </button>
          )}
          {page + 1 < pageCount ? (
            <Link
              className="btn btn-sm"
              to={`?page=${page + 1}`}
              preventScrollReset
            >
              Next
            </Link>
          ) : (
            <button type="button" className="btn btn-sm" disabled>
              Next
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
