import { useState } from "react";
import { redirect } from "react-router";

import type { Route } from "./+types/home";
import { getSessionUser } from "~/lib/auth.server";
import { signInWithVAuth } from "~/lib/auth-client";

export function meta() {
  return [
    { title: "V Rooms" },
    {
      name: "description",
      content:
        "One room, the whole college. Pseudonymous, for verified VIT students.",
    },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  const user = await getSessionUser(request);
  if (user) throw redirect("/room/campus-live");
  return {};
}

export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-[560px] flex-col justify-center px-5 py-16">
      <div className="wordmark mb-10">
        <i />V ROOMS <small>voss labs</small>
      </div>

      <h1 className="mb-4 text-[28px] leading-tight font-semibold tracking-tight text-balance">
        One room, the whole college.
      </h1>

      <p className="text-ink-2 mb-5 text-[15px] leading-relaxed">
        Campus Live is a single conversation open to every verified VIT student.
        No invite, no phone number, nobody you have to already know. You get one
        handle and you keep it.
      </p>

      {/* VRIP-04 requires this to be stated plainly, in the product, before anyone signs in. */}
      <div className="border-line-2 bg-panel mb-7 rounded-[10px] border p-4">
        <h2 className="mb-2 text-[14px] font-semibold">
          Read this before you sign in
        </h2>
        <p className="text-ink-2 text-[13.5px] leading-relaxed">
          Other students see a handle and nothing else. VOSS can see who you
          are. The mapping from your handle to your V Auth account is kept so
          that abuse can be acted on, and every time a moderator resolves it the
          lookup is recorded against the message that justified it. This is
          anonymity between students, never between you and the platform.
        </p>
      </div>

      <SignInButton />

      <p className="text-ink-3 mt-4 text-[12.5px] leading-relaxed">
        You need a V Auth account, the same one you use for VERP. V Rooms holds
        no password of its own.
      </p>

      <p className="text-ink-3 mt-10 text-[12.5px]">
        Built by{" "}
        <a
          className="text-ink-2 underline underline-offset-4"
          href="https://vosslabs.org"
        >
          VOSS Labs
        </a>
        . The rooms that do not exist yet are open issues.
      </p>
    </main>
  );
}

function SignInButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setPending(true);
    setError(null);
    try {
      await signInWithVAuth("/room/campus-live");
    } catch {
      // The redirect never happened, so the user is still here and needs telling.
      setError("Could not reach V Auth. Check your connection and try again.");
      setPending(false);
    }
  }

  return (
    <div>
      <button
        className="btn btn-primary h-11 w-full text-[14px]"
        type="button"
        onClick={start}
        disabled={pending}
      >
        {pending ? "Taking you to V Auth" : "Continue with V Auth"}
      </button>
      {error && (
        <p role="alert" className="text-neg mt-3 text-[13px]">
          {error}
        </p>
      )}
    </div>
  );
}
