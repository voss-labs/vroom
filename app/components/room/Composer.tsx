import { useEffect, useRef, useState, type FormEvent } from "react";

import type { RoomMeta } from "~/lib/rooms";
import { cn } from "~/lib/utils";
import { detect, TIER } from "../../../workers/policy";

/**
 * The composer, and VRIP-09's confirm step.
 *
 * The dialog is a nudge, not a control: it is JavaScript in someone's browser
 * and a hostile client simply never asks, which is why the room object re-runs
 * the same detector on every frame. What the dialog buys is the case where
 * nobody is being hostile — someone about to paste a phone number or name a
 * lecturer, who would not have done it if asked.
 *
 * It fires on the confirm tier and on nothing else. Everyday profanity is
 * counted silently on the server precisely so this never fires on it: a dialog
 * students see daily is one they dismiss on reflex, and then it protects
 * nobody.
 */

const LIMIT = 500;
/** The counter stays out of the way until the limit is actually in reach. */
const COUNTER_FROM = 400;

const DIALOG =
  "m-auto w-[calc(100%-32px)] max-w-[440px] rounded-[var(--r-card)] border border-line-2 " +
  "bg-panel p-0 text-ink backdrop:bg-black/60";

export interface ComposerDraft {
  text: string;
  seq: number;
}

export interface ComposerProps {
  killed: boolean;
  connected: boolean;
  /** Returns false when the socket refused the frame; the input then keeps it. */
  onSend: (body: string, confirmed: boolean) => boolean;
  room: RoomMeta;
  draft?: ComposerDraft | null;
}

interface Pending {
  body: string;
  matches: string[];
}

export function Composer({
  killed,
  connected,
  onSend,
  room,
  draft,
}: ComposerProps) {
  const [value, setValue] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const disabled = killed || !connected;
  const counting = value.length > COUNTER_FROM;

  useEffect(() => {
    if (!draft) return;
    setValue((prev) => {
      if (draft.text.startsWith("@")) {
        const prefix = draft.text;
        if (prev.startsWith(prefix)) return prev;
        return `${prefix}${prev}`.slice(0, LIMIT);
      }
      return draft.text.slice(0, LIMIT);
    });
    inputRef.current?.focus();
  }, [draft]);

  function send(body: string, confirmed: boolean) {
    if (onSend(body, confirmed)) setValue("");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = value.trim().slice(0, LIMIT);
    if (!body || disabled) return;

    const found = detect(body);
    if (found.tier === TIER.CONFIRM) {
      setPending({ body, matches: found.matches });
      return;
    }
    send(body, false);
  }

  return (
    <>
      <form className="composer" onSubmit={submit}>
        <label className="sr" htmlFor="msg">
          Message {room.name}
        </label>
        <div className="relative flex min-w-0 flex-1">
          <input
            ref={inputRef}
            id="msg"
            className={cn("w-full", counting && "pr-11")}
            autoComplete="off"
            maxLength={LIMIT}
            disabled={disabled}
            placeholder={killed ? "The room is closed" : room.placeholder}
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

      <ConfirmSend
        pending={pending}
        onCancel={() => setPending(null)}
        onConfirm={(body) => {
          setPending(null);
          send(body, true);
        }}
      />
    </>
  );
}

interface ConfirmSendProps {
  pending: Pending | null;
  onCancel: () => void;
  onConfirm: (body: string) => void;
}

function ConfirmSend({ pending, onCancel, onConfirm }: ConfirmSendProps) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (pending && !dialog.open) {
      const active = document.activeElement;
      restoreTo.current = active instanceof HTMLElement ? active : null;
      dialog.showModal();
    } else if (!pending && dialog.open) {
      dialog.close();
    }
  }, [pending]);

  // Escape closes the native dialog without telling React, so the close event is
  // the one place that clears the parent's state and puts focus back.
  function handleClose() {
    const target = restoreTo.current;
    restoreTo.current = null;
    if (target?.isConnected) target.focus();
    onCancel();
  }

  return (
    <dialog
      ref={ref}
      className={DIALOG}
      aria-labelledby="confirm-send-title"
      onClose={handleClose}
    >
      <div className="px-[22px] pt-[22px]">
        <h2
          id="confirm-send-title"
          className="text-[16px] font-semibold tracking-[-0.01em]"
        >
          Send this?
        </h2>
        <p className="text-ink-2 mt-2 text-[13.5px] leading-[1.55]">
          {pending
            ? `This message contains ${list(pending.matches)}. The whole college reads Campus Live, and nothing posted here can be edited.`
            : ""}
        </p>
        {pending && (
          <div className="border-line-2 bg-panel-2 text-ink-2 mt-3 rounded-[var(--r-ctl)] border p-3 text-[13px] leading-[1.5] [overflow-wrap:anywhere]">
            {pending.body}
          </div>
        )}
      </div>
      <div className="mt-[18px] flex justify-end gap-2 px-[22px] pb-[22px]">
        <button
          type="button"
          className="btn h-11"
          onClick={() => ref.current?.close()}
        >
          Go back
        </button>
        <button
          type="button"
          className="btn btn-primary h-11"
          onClick={() => {
            if (pending) onConfirm(pending.body);
          }}
        >
          Send anyway
        </button>
      </div>
    </dialog>
  );
}

function list(matches: string[]): string {
  if (matches.length <= 1) return matches[0] ?? "personal information";
  return `${matches.slice(0, -1).join(", ")} and ${matches[matches.length - 1]}`;
}
