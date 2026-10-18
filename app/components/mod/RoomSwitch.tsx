import { useState } from "react";
import { useFetcher } from "react-router";

import { ERROR_NOTE } from "./RowMenu";
import { auditTime } from "~/lib/utils";
import type { ModActionData } from "~/routes/mod";

/**
 * The kill switch. It is Durable Object state, not an environment variable, so
 * it takes effect on the next frame for everyone in the room (VRIP-05).
 */

const OPEN_COPY =
  "Closing the rooms freezes all 5 rooms for everyone within a second. History stays readable, nobody can " +
  "post. Use it when reports arrive faster than you can act on them.";

const CLOSED_COPY =
  "Nobody can post in any room. History stays readable, and the rooms say so rather than looking broken. " +
  "Reopen when you have hands on it.";

const UNKNOWN_COPY =
  "A room is unreachable, so its state cannot be read or changed right now. The report queue " +
  "below is unaffected.";

interface RoomSwitchProps {
  /** null when the Durable Object could not be read. */
  killed: boolean | null;
  killedAt?: number | null;
  killedBy?: string | null;
}

export function RoomSwitch({ killed, killedAt, killedBy }: RoomSwitchProps) {
  const fetcher = useFetcher<ModActionData>();
  const [reason, setReason] = useState("");
  const submitting = fetcher.state !== "idle";
  const submitted = submitting
    ? fetcher.formData?.get("killed") === "true"
    : null;

  const closed = submitted ?? killed ?? false;
  const unknown = killed === null && submitted === null;

  return (
    <section className="sec">
      <fetcher.Form
        method="post"
        className="roomctl flex-wrap"
        onSubmit={() => setReason("")}
      >
        <input type="hidden" name="intent" value="set_room_state" />
        <input type="hidden" name="killed" value={String(!closed)} />
        {!closed && reason.trim() ? (
          <input type="hidden" name="reason" value={reason.trim()} />
        ) : null}

        <div className="min-w-0 flex-1">
          <h2 className="flex flex-wrap items-center gap-[9px] text-[15px] font-semibold">
            Room status
            <span
              className={
                unknown ? "badge" : closed ? "badge badge-no" : "badge badge-ok"
              }
            >
              {unknown ? "Unknown" : closed ? "Closed" : "Open"}
            </span>
            {closed && killedAt ? (
              <span className="text-ink-3 font-mono text-[11px] font-normal">
                closed {auditTime(new Date(killedAt))}
                {killedBy ? ` by ${killedBy}` : ""}
              </span>
            ) : null}
          </h2>
          <p className="text-ink-2 mt-1 max-w-[72ch] text-[13px] leading-[1.55]">
            {unknown ? UNKNOWN_COPY : closed ? CLOSED_COPY : OPEN_COPY}
          </p>
          {!unknown && !closed && (
            <div className="mt-2.5 max-w-sm">
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Optional reason for audit log before closing..."
                aria-label="Reason for closing rooms"
                className="border-line-2 bg-ground text-ink placeholder:text-ink-3 focus:border-brand h-8 w-full rounded-[var(--r-ctl)] border px-2.5 text-xs focus:outline-none"
              />
            </div>
          )}
          {fetcher.data?.error && (
            <p role="alert" className={`${ERROR_NOTE} mt-2`}>
              {fetcher.data.error.code}: {fetcher.data.error.message}
            </p>
          )}
        </div>

        <button
          type="submit"
          className="sw disabled:cursor-not-allowed disabled:opacity-40"
          role="switch"
          aria-checked={closed}
          aria-label={closed ? "Open the room" : "Close the room"}
          disabled={unknown || submitting}
        />
      </fetcher.Form>
    </section>
  );
}
