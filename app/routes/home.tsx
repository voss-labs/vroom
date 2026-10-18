import { useState } from "react";
import { redirect, useNavigate } from "react-router";

import type { Route } from "./+types/home";
import { signInWithVAuth } from "~/lib/auth-client";
import {
  DeviceKeyUnavailable,
  SignInRefused,
  enterWithDeviceKey,
} from "~/lib/device-key.client";
import { resolveActor } from "~/lib/require-role.server";
import { readRoomPulses, type RoomPulse } from "~/lib/room.server";
import { DEFAULT_ROOM_ID, ROOM_IDS, ROOMS, type RoomId } from "~/lib/rooms";
import { isVAuthSignInOpen } from "~/lib/sign-in.server";

export function meta() {
  return [
    { title: "V Rooms" },
    {
      name: "description",
      content:
        "One room, the whole college. Anonymous, real-time campus rooms for VIT students.",
    },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const actor = await resolveActor(request);
  if (actor) throw redirect("/room");
  const pulses = await readRoomPulses();
  // Only moderators use V Auth since VRIP-13, so the pause hides their link alone.
  return {
    moderatorSignInOpen: isVAuthSignInOpen(),
    pulses,
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const [targetRoom, setTargetRoom] = useState<RoomId>(DEFAULT_ROOM_ID);
  const pulses = loaderData.pulses;
  const totalOnline = pulses
    ? Object.values(pulses).reduce((sum, p) => sum + p.online, 0)
    : null;

  return (
    <main className="mx-auto flex min-h-dvh max-w-[620px] flex-col justify-center px-5 py-14">
      <div className="mb-8 flex flex-wrap items-center justify-between gap-2">
        <div className="wordmark">
          <i />V ROOMS <small>voss labs</small>
        </div>
        <div className="flex items-center gap-2">
          {totalOnline !== null && totalOnline > 0 && (
            <span className="tag tag-live">
              <span className="mark" />
              {totalOnline} active now
            </span>
          )}
          <span className="tag">48h disappearing window</span>
        </div>
      </div>

      <h1 className="mb-3 text-[28px] leading-tight font-semibold tracking-tight text-balance">
        One room, the whole college.
      </h1>

      <p className="text-ink-2 mb-6 text-[15px] leading-relaxed">
        Campus Live and four topic rooms open to every VIT student. No sign-up,
        no email, no phone number, nobody you have to already know. You get one
        handle and keep it on this device.
      </p>

      <EnterButton targetRoom={targetRoom} />

      <div className="border-line-2 bg-panel mt-6 rounded-[var(--r-card)] border p-4">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="text-ink-3 font-mono text-[11px] font-semibold tracking-[0.12em] uppercase">
            Pick a Room to Enter
          </h2>
          <span className="text-ink-3 font-mono text-[11px]">
            switch anytime inside
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ROOM_IDS.map((id) => {
            const r = ROOMS[id];
            const pulse: RoomPulse | undefined = pulses?.[id];
            const selected = targetRoom === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => setTargetRoom(id)}
                aria-pressed={selected}
                className={`flex cursor-pointer flex-col gap-1 rounded-[var(--r-ctl)] border px-3 py-2.5 text-left transition-colors ${
                  selected
                    ? "border-brand bg-raised-2 text-ink"
                    : "border-line bg-panel-2 hover:border-line-3 hover:bg-raised text-ink-2"
                }`}
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <span className="text-ink font-mono text-[13px] font-semibold">
                    <span className="text-brand">#</span>
                    {r.id}
                  </span>
                  {pulse && (
                    <span className="text-ink-3 font-mono text-[11px] tabular-nums">
                      {pulse.online > 0
                        ? `${pulse.online} online`
                        : pulse.messages > 0
                          ? `${pulse.messages} msgs`
                          : "quiet"}
                    </span>
                  )}
                </div>
                <span className="text-ink-3 truncate text-[12px]">
                  {r.subtitle}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* VRIP-13 requires this to be stated plainly, in the product, before anyone enters. */}
        <div className="border-line-2 bg-panel rounded-[var(--r-card)] border p-4">
          <h2 className="mb-1.5 text-[13.5px] font-semibold">
            How anonymous this is
          </h2>
          <p className="text-ink-2 mb-2 text-[13px] leading-relaxed">
            Other students see a handle and nothing else, and so does VOSS. This
            browser makes a key that never leaves it, and V Rooms stores only a
            hash of that key. No name, no email, and no IP address are kept.
            Cloudflare, which runs the servers, sees your IP address in transit.
          </p>
          <p className="text-ink-2 text-[13px] leading-relaxed">
            Nobody can recover your handle. Clear this site&apos;s data or
            switch devices and you come back as someone new.
          </p>
        </div>

        <div className="border-line-2 bg-panel rounded-[var(--r-card)] border p-4">
          <h2 className="mb-1.5 text-[13.5px] font-semibold">
            48-hour disappearing messages
          </h2>
          <p className="text-ink-2 mb-2 text-[13px] leading-relaxed">
            Every stored message in a room automatically disappears 48 hours
            after it is sent and is deleted from the room database.
          </p>
          <p className="text-ink-2 text-[13px] leading-relaxed">
            You can also withdraw your own messages at any time, or block any
            handle on your device in one click. Moderators can still remove
            messages and suspend handles that break the rules.
          </p>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
        <p className="text-ink-3 text-[12.5px]">
          Built by{" "}
          <a
            className="text-ink-2 underline underline-offset-4"
            href="https://vosslabs.org"
          >
            VOSS Labs
          </a>
          . The rooms that do not exist yet are open issues.
        </p>

        {loaderData.moderatorSignInOpen && <ModeratorSignIn />}
      </div>
    </main>
  );
}

function enterError(error: unknown): string {
  if (error instanceof DeviceKeyUnavailable)
    return "This browser cannot keep a key, which happens in some private windows. Open V Rooms in a normal window.";
  if (error instanceof SignInRefused) return error.message;
  return "Could not reach V Rooms. Check your connection and try again.";
}

function EnterButton({ targetRoom }: { targetRoom: RoomId }) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enter() {
    setPending(true);
    setError(null);
    try {
      await enterWithDeviceKey();
      navigate(
        targetRoom === DEFAULT_ROOM_ID ? "/room" : `/room/${targetRoom}`,
      );
    } catch (failure) {
      setError(enterError(failure));
      setPending(false);
    }
  }

  return (
    <div>
      <button
        className="btn btn-primary h-11 w-full text-[14px]"
        type="button"
        onClick={enter}
        disabled={pending}
      >
        {pending
          ? `Entering #${targetRoom}...`
          : targetRoom === DEFAULT_ROOM_ID
            ? "Enter anonymously"
            : `Enter #${targetRoom} anonymously`}
      </button>
      {error && (
        <p role="alert" className="text-neg mt-3 text-[13px]">
          {error}
        </p>
      )}
    </div>
  );
}

/** Moderators keep V Auth so every moderation action has an accountable person (VRIP-13). */
function ModeratorSignIn() {
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    try {
      await signInWithVAuth("/mod");
    } catch {
      setError("Could not reach V Auth. Try again.");
    }
  }

  return (
    <div>
      <button
        type="button"
        className="text-ink-3 hover:text-ink-2 inline-flex min-h-11 items-center text-[12.5px] underline underline-offset-4"
        onClick={start}
      >
        VOSS moderator? Sign in with V Auth
      </button>
      {error && (
        <p role="alert" className="text-neg text-[12.5px]">
          {error}
        </p>
      )}
    </div>
  );
}
