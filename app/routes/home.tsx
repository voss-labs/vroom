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
import { ROOM_IDS, ROOMS } from "~/lib/rooms";
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
  // Only moderators use V Auth since VRIP-13, so the pause hides their link alone.
  return { moderatorSignInOpen: isVAuthSignInOpen() };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[600px] flex-col justify-center px-5 py-14">
      <div className="mb-8 flex items-center justify-between">
        <div className="wordmark">
          <i />V ROOMS <small>voss labs</small>
        </div>
        <span className="tag">48h disappearing window</span>
      </div>

      <h1 className="mb-3 text-[28px] leading-tight font-semibold tracking-tight text-balance">
        One room, the whole college.
      </h1>

      <p className="text-ink-2 mb-6 text-[15px] leading-relaxed">
        Campus Live and four topic rooms open to every VIT student. No sign-up,
        no email, no phone number, nobody you have to already know. You get one
        handle and keep it on this device.
      </p>

      <EnterButton />

      <div className="mt-7 grid grid-cols-1 gap-3 sm:grid-cols-2">
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

      <div className="border-line-2 bg-panel mt-3 rounded-[var(--r-card)] border p-4">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="text-ink-3 font-mono text-[11px] font-semibold tracking-[0.12em] uppercase">
            5 Live Campus Rooms
          </h2>
          <span className="text-ink-3 font-mono text-[11px]">
            instant switch inside
          </span>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {ROOM_IDS.map((id) => {
            const r = ROOMS[id];
            return (
              <div
                key={id}
                className="border-line bg-panel-2 flex items-baseline gap-2 rounded-[var(--r-ctl)] border px-3 py-2"
              >
                <span className="text-ink font-mono text-[13px] font-semibold">
                  <span className="text-brand">#</span>
                  {r.id}
                </span>
                <span className="text-ink-3 truncate text-[12px]">
                  {r.subtitle}
                </span>
              </div>
            );
          })}
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

function EnterButton() {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function enter() {
    setPending(true);
    setError(null);
    try {
      await enterWithDeviceKey();
      navigate("/room");
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
        {pending ? "Entering..." : "Enter anonymously"}
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
