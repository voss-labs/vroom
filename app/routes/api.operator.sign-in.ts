import type { LoaderFunctionArgs } from "react-router";

import { auth, getSessionUser } from "~/lib/auth.server";
import { isVAuthSignInOpen } from "~/lib/sign-in.server";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" };

function unavailable(status = 503) {
  return Response.json(
    { error: "operator_sign_in_unavailable" },
    { status, headers: PRIVATE_HEADERS },
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method !== "GET") return unavailable(405);
  try {
    const user = await getSessionUser(request);
    if (user) {
      return Response.json({ userId: user.id }, { headers: PRIVATE_HEADERS });
    }
    if (!isVAuthSignInOpen()) return unavailable();
    const result = await auth.api.signInWithOAuth2({
      headers: request.headers,
      body: { providerId: "voss", callbackURL: "/api/operator/sign-in" },
      asResponse: true,
    });
    if (!result.ok) return unavailable();
    const payload: unknown = await result.json();
    if (
      !payload ||
      typeof payload !== "object" ||
      !("url" in payload) ||
      typeof payload.url !== "string"
    )
      return unavailable();
    const destination = new URL(payload.url);
    if (destination.protocol !== "https:") return unavailable();
    const headers = new Headers(result.headers);
    headers.set("Location", destination.href);
    headers.set("Cache-Control", PRIVATE_HEADERS["Cache-Control"]);
    headers.delete("Content-Type");
    return new Response(null, { status: 302, headers });
  } catch {
    return unavailable();
  }
}
