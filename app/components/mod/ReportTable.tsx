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
 * The report queue, in the shadcn data-table idiom the prototype draws: filter,
 * column toggle, checkbox selection, one sortable header, a row overflow menu
 * and a selection footer.
 *
 * Pagination is server-side and real. Filtering and sorting stay client-side and
 * therefore act on the current page only, which the footer says out loud — the
 * queue is a safety surface, and a row it silently drops is a report nobody
 * acts on.
 *
 * There is no identity column. A handle is a device key with no person behind
 * it, so the remedies are the message and the handle (VRIP-13).
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
    const query = filter.trim().toLowerCase();
    const matched = reports.filter((report) => {
      if (statusFilter === "open" && report.status !== "open") return false;
      if (statusFilter === "closed" && report.status === "open") return false;
      if (!query) return true;
      return (
        report.snapshot.toLowerCase().includes(query) ||
        (report.handle ?? "").toLowerCase().includes(query) ||
        (report.roomId ?? "").toLowerCase().includes(query) ||
        (report.reason ?? "").toLowerCase().includes(query)
      );
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

  function act(
    intent: string,
    reportId: string,
    extra?: Record<string, string>,
  ) {
    fetcher.submit({ intent, reportId, ...extra }, { method: "post" });
  }

  function toggleColumn(column: Column) {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  }

  function toggleRow(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allSelected =
    rows.length > 0 && rows.every((row) => selected.has(row.id));

  function menuFor(report: ReportRow): MenuItem[] {
    const done = report.status !== "open";
    const isAutoFlag = report.messageId.startsWith("flag:");
    return [
      {
        kind: "label",
        text: isAutoFlag
          ? `Policy flag ${report.messageId}`
          : `Report on message ${report.messageId.slice(0, 8)}`,
      },
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
    <section className="sec">
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
                onSelect: () => toggleColumn("room"),
              },
              {
                text: "Author",
                tick: !hidden.has("author"),
                keepOpen: true,
                onSelect: () => toggleColumn("author"),
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
                {!hidden.has("room") && <th>Room</th>}
                {!hidden.has("author") && (
                  <th
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
                          onChange={() => toggleRow(report.id)}
                        />
                      </label>
                    </td>
                    <td>
                      <div className="cell-msg">{report.snapshot}</div>
                      <div className="cell-sub flex flex-wrap items-center gap-1.5">
                        <span>
                          {isAutoFlag
                            ? `Auto-flag · ${report.reason ?? "policy match"}`
                            : `Message ${report.messageId.slice(0, 8)} · ${report.reason ?? "reported by a student"}`}
                        </span>
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
                      <td className="text-ink-2 font-mono text-xs whitespace-nowrap">
                        #{report.roomId ?? "campus-live"}
                      </td>
                    )}
                    {!hidden.has("author") && (
                      <td
                        className="cell-handle"
                        style={{
                          color: report.handle
                            ? handleColour(report.handle)
                            : undefined,
                        }}
                      >
                        {report.handle ?? "no handle"}
                      </td>
                    )}
                    <td className={COL_A}>
                      <RowMenu
                        label="Actions for this report"
                        className={DOTS}
                        disabled={busy}
                        items={menuFor(report)}
                      >
                        <span aria-hidden="true">⋯</span>
                      </RowMenu>
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
