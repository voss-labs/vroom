import { useState } from "react";
import { data, redirect, useNavigate } from "react-router";

import type { Route } from "./+types/home";
import { ThemeToggle } from "~/components/ThemeToggle";
import {
  DeviceKeyUnavailable,
  SignInRefused,
  enterWithDeviceKey,
} from "~/lib/device-key.client";
import { resolveActor } from "~/lib/require-role.server";
import { readRoomPulses, type RoomPulse } from "~/lib/room.server";
import { DEFAULT_ROOM_ID, ROOM_IDS, ROOMS, type RoomId } from "~/lib/rooms";

export const headers = () => ({ "Cache-Control": "private, no-store" });
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
  if (actor)
    throw redirect("/room", {
      headers: { "Cache-Control": "private, no-store" },
    });
  const pulses = await readRoomPulses();
  return data(
    { pulses },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const [targetRoom, setTargetRoom] = useState<RoomId>(DEFAULT_ROOM_ID);
  const pulses = loaderData.pulses;
  const totalOnline = pulses
    ? Object.values(pulses).reduce((sum, p) => sum + p.online, 0)
    : null;

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[660px] flex-col justify-center px-4 pt-8 pb-20 sm:px-6 sm:py-14">
      <div className="mb-7 flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-line-2)] pb-3.5">
        <div className="wordmark">
          <i />V ROOMS <small>voss labs</small>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {totalOnline !== null && totalOnline > 0 && (
            <span className="tag tag-live">
              <span className="mark" />
              {totalOnline} active now
            </span>
          )}
          <span className="tag max-[420px]:hidden">48h window</span>
          <ThemeToggle />
        </div>
      </div>

      <h1 className="mb-3 text-[24px] leading-tight font-semibold tracking-tight text-balance sm:text-[28px]">
        One room, the whole college.
      </h1>

      <p className="text-ink-2 mb-6 text-[14.5px] leading-relaxed sm:text-[15px]">
        Campus Live and four topic rooms open to every VIT student. No sign-up,
        no email, no phone number, nobody you have to already know. You get one
        handle and keep it in this browser.
      </p>

      <EnterButton targetRoom={targetRoom} />

      <div className="rail-card mt-6">
        <div className="rail-card-head">
          <span>Channels · Pick a Room</span>
          <span>switch anytime inside</span>
        </div>
        <div className="bg-panel grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
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
                className={`flex min-h-14 cursor-pointer flex-col justify-center gap-1 rounded-[var(--r-ctl)] border px-3 py-2.5 text-left transition-colors ${
                  selected
                    ? "border-brand bg-raised text-ink"
                    : "border-line-2 bg-ground hover:border-line-3 hover:bg-panel-2 text-ink-2"
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
        <div className="rail-card flex flex-col">
          <div className="rail-card-head">
            <span>Privacy</span>
            <span>VRIP-13</span>
          </div>
          <div className="bg-panel flex-1 p-3.5">
            <h2 className="mb-1.5 text-[13.5px] font-semibold">
              How anonymous this is
            </h2>
            <p className="text-ink-2 mb-2 text-[13px] leading-relaxed">
              Other students see a handle and nothing else, and so does VOSS.
              This browser makes a private key that never leaves it, and V Rooms
              stores only a hash of that key. No name, no email, and no IP
              address are kept. Cloudflare, which runs the servers, sees your IP
              address in transit.
            </p>
            <p className="text-ink-2 text-[13px] leading-relaxed">
              Nobody can recover your handle. Clear this site&apos;s data or
              switch devices and you come back as someone new.
            </p>
          </div>
        </div>

        <div className="rail-card flex flex-col">
          <div className="rail-card-head">
            <span>Retention</span>
            <span>48h SQLite</span>
          </div>
          <div className="bg-panel flex-1 p-3.5">
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
      </div>

      <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--color-line)] pt-4">
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
