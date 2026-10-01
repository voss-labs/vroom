import { useState, type FormEvent } from "react";

import { cn } from "~/lib/utils";

const LIMIT = 500;
/** The counter stays out of the way until the limit is actually in reach. */
const COUNTER_FROM = 400;

export interface ComposerProps {
  killed: boolean;
  connected: boolean;
  /** Returns false when the socket refused the frame; the input then keeps it. */
  onSend: (body: string) => boolean;
  placeholder?: string;
}

export function Composer({ killed, connected, onSend, placeholder }: ComposerProps) {
  const [value, setValue] = useState("");
  const disabled = killed || !connected;
  const counting = value.length > COUNTER_FROM;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = value.trim();
    if (!body || disabled) return;
    if (onSend(body.slice(0, LIMIT))) setValue("");
  }

  return (
    <form className="composer" onSubmit={submit}>
      <label className="sr" htmlFor="msg">
        Message
      </label>
      <div className="relative flex min-w-0 flex-1">
        <input
          id="msg"
          className={cn("w-full", counting && "pr-11")}
          autoComplete="off"
          maxLength={LIMIT}
          disabled={disabled}
          placeholder={
            killed ? "The room is closed" : (placeholder || "Say something to the college")
          }
          value={value}
          onChange={(event) => setValue(event.target.value.slice(0, LIMIT))}
        />
        {counting ? (
          <span
            className="text-ink-3 pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-[11px] tabular-nums"
            aria-hidden="true"
          >
            {LIMIT - value.length}
          </span>
        ) : null}
      </div>
      <button
        className="btn btn-primary"
        type="submit"
        disabled={disabled || !value.trim()}
      >
        Send
      </button>
    </form>
  );
}
