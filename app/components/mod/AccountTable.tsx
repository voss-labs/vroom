import { useMemo, useState } from "react";
import { useFetcher } from "react-router";

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
import { cn, handleColour } from "~/lib/utils";
import type { ModActionData } from "~/routes/mod";

/**
 * The accounts table. There is no email column and there never will be:
 * students authenticate with a browser device key and have no email or name
 * in the database (VRIP-13). Suspending a handle closes its sockets across
 * every room and blocks reconnection.
 *
 * The message count is a Durable Object read across the 48-hour window, so it
 * is an em dash rather than a zero when a room is unreachable.
 */

export interface AccountRow {
  id: string;
  handle: string;
  suspended: boolean;
  suspendedReason: string | null;
}

type Column = "messages" | "status";
type SortKey = "handle" | "messages";
type AccountFilter = "all" | "active" | "suspended";

const PAGE_SIZE = 25;

interface AccountTableProps {
  accounts: AccountRow[];
  /** Message counts keyed on handle, or null when the room is unreachable. */
  counts: Record<string, number> | null;
}

export function AccountTable({ accounts, counts }: AccountTableProps) {
  const fetcher = useFetcher<ModActionData>();
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<AccountFilter>("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [hidden, setHidden] = useState<Set<Column>>(new Set());

  const filteredRows = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const matched = accounts.filter((account) => {
      if (statusFilter === "active" && account.suspended) return false;
      if (statusFilter === "suspended" && !account.suspended) return false;
      if (!query) return true;
      return (
        account.handle.toLowerCase().includes(query) ||
        (account.suspendedReason ?? "").toLowerCase().includes(query)
      );
    });
    if (!sort) return matched;
    return [...matched].sort((a, b) => {
      if (sort.key === "handle")
        return a.handle.localeCompare(b.handle) * sort.dir;
      const left = counts?.[a.handle] ?? 0;
      const right = counts?.[b.handle] ?? 0;
      return (left - right) * sort.dir;
    });
  }, [accounts, counts, filter, statusFilter, sort]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = useMemo(
    () =>
      filteredRows.slice(
        safePage * PAGE_SIZE,
        safePage * PAGE_SIZE + PAGE_SIZE,
      ),
    [filteredRows, safePage],
  );

  const busyId =
    fetcher.state !== "idle"
      ? String(fetcher.formData?.get("memberId") ?? "")
      : "";
  const allSelected =
    rows.length > 0 && rows.every((row) => selected.has(row.id));

  function onSort(key: SortKey) {
    setSort((current) =>
      current?.key === key
        ? { key, dir: current.dir === 1 ? -1 : 1 }
        : { key, dir: 1 },
    );
  }

  function arrow(key: SortKey) {
    if (sort?.key !== key) return "↕";
    return sort.dir === 1 ? "↑" : "↓";
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

  function menuFor(account: AccountRow): MenuItem[] {
    return [
      { kind: "label", text: account.handle },
      {
        text: "Copy handle",
        onSelect: () => {
          void navigator.clipboard?.writeText(account.handle);
        },
      },
      { kind: "sep" },
      {
        text: account.suspended ? "Restore account" : "Suspend account",
        danger: !account.suspended,
        onSelect: () =>
          fetcher.submit(
            {
              intent: account.suspended ? "restore" : "suspend",
              memberId: account.id,
            },
            { method: "post" },
          ),
      },
    ];
  }

  return (
    <section className="sec overflow-hidden">
      <div className="rail-card-head px-4 py-2.5">
        <span>Identity Registry · Device Keys</span>
        <span>{accounts.length} handles</span>
      </div>
      <div className="sec-head">
        <h2>Accounts</h2>
        <p>
          Device-key handles only — no personal data is stored. Suspending a
          handle closes its active connections across all rooms and refuses
          reconnection.
        </p>
      </div>

      <div className="toolbar">
        <input
          className="inp"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            setPage(0);
          }}
          placeholder="Filter handles or reasons..."
          aria-label="Filter handles"
        />
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="Filter accounts by status"
        >
          {(["all", "active", "suspended"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => {
                setStatusFilter(mode);
                setPage(0);
              }}
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
                text: "Messages (48h)",
                tick: !hidden.has("messages"),
                keepOpen: true,
                onSelect: () => toggleColumn("messages"),
              },
              {
                text: "Status",
                tick: !hidden.has("status"),
                keepOpen: true,
                onSelect: () => toggleColumn("status"),
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
                      aria-label="Select all accounts"
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
                <th>
                  <button
                    type="button"
                    className={SORTBTN}
                    onClick={() => onSort("handle")}
                  >
                    Handle
                    <i
                      className="text-ink-3 text-[11px] not-italic"
                      aria-hidden="true"
                    >
                      {arrow("handle")}
                    </i>
                  </button>
                </th>
                {!hidden.has("messages") && (
                  <th className="max-[540px]:hidden">
                    <button
                      type="button"
                      className={SORTBTN}
                      onClick={() => onSort("messages")}
                    >
                      Messages (48h)
                      <i
                        className="text-ink-3 text-[11px] not-italic"
                        aria-hidden="true"
                      >
                        {arrow("messages")}
                      </i>
                    </button>
                  </th>
                )}
                {!hidden.has("status") && <th>Status</th>}
                <th className={COL_A}>
                  <span className="sr">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((account) => {
                const busy = busyId === account.id;
                const messages = counts ? (counts[account.handle] ?? 0) : null;
                return (
                  <tr key={account.id} aria-busy={busy}>
                    <td className={COL_X}>
                      <label className={CBX_HIT}>
                        <input
                          type="checkbox"
                          className={CBX}
                          checked={selected.has(account.id)}
                          aria-label={`Select ${account.handle}`}
                          onChange={() => toggleRow(account.id)}
                        />
                      </label>
                    </td>
                    <td>
                      <div
                        className="cell-handle"
                        style={{ color: handleColour(account.handle) }}
                      >
                        {account.handle}
                      </div>
                      {account.suspended && account.suspendedReason && (
                        <div className="cell-sub">
                          Reason: {account.suspendedReason}
                        </div>
                      )}
                    </td>
                    {!hidden.has("messages") && (
                      <td className="font-mono tabular-nums max-[540px]:hidden">
                        {messages === null ? (
                          <>
                            <span aria-hidden="true">—</span>
                            <span className="sr">unavailable</span>
                          </>
                        ) : (
                          messages.toLocaleString("en-US")
                        )}
                      </td>
                    )}
                    {!hidden.has("status") && (
                      <td>
                        <span
                          className={
                            account.suspended
                              ? "badge badge-no"
                              : "badge badge-ok"
                          }
                        >
                          {account.suspended ? "Suspended" : "Active"}
                        </span>
                        {busy && <span className="cell-sub">working</span>}
                      </td>
                    )}
                    <td className={COL_A}>
                      <RowMenu
                        label={`Actions for ${account.handle}`}
                        className={DOTS}
                        disabled={busy}
                        items={menuFor(account)}
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
              {accounts.length === 0
                ? "Nobody has a handle yet."
                : "No handles match that filter."}
            </div>
          )}
        </div>
      </div>

      <div className={TBL_FOOT}>
        <span>
          {`${selected.size} of ${rows.length} row(s) selected. Page ${safePage + 1} of ${pageCount}, ${filteredRows.length} handle(s).`}
        </span>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            className="btn btn-sm"
            disabled={safePage === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            Previous
          </button>
          <button
            type="button"
            className="btn btn-sm"
            disabled={safePage + 1 >= pageCount}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          >
            Next
          </button>
        </div>
      </div>
    </section>
  );
}
