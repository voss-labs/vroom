import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSessionUser = vi.fn();
const signInWithOAuth2 = vi.fn();
vi.mock("~/lib/auth.server", () => ({
  getSessionUser,
  auth: { api: { signInWithOAuth2 } },
}));
const { loader } = await import("~/routes/api.operator.sign-in");
const env = process.env as Record<string, string | undefined>;
const previous = env.VAUTH_SIGN_IN;
const request = () =>
  new Request("https://vroom.vosslabs.org/api/operator/sign-in");

beforeEach(() => {
  vi.clearAllMocks();
  env.VAUTH_SIGN_IN = "on";
  getSessionUser.mockResolvedValue(null);
});
afterEach(() => {
  if (previous === undefined) delete env.VAUTH_SIGN_IN;
  else env.VAUTH_SIGN_IN = previous;
});

describe("operator V Auth bootstrap", () => {
  it("uses configured OAuth and preserves state cookies while redirecting", async () => {
    signInWithOAuth2.mockResolvedValue(
      Response.json(
        {
          url: "https://accounts.vosslabs.org/oauth/authorize?state=opaque",
          redirect: true,
        },
        {
          headers: {
            "Set-Cookie": "oauth-state=opaque; HttpOnly; Secure; SameSite=Lax",
          },
        },
      ),
    );
    const response = await loader({ request: request() } as never);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain(
      "https://accounts.vosslabs.org/",
    );
    expect(response.headers.get("Set-Cookie")).toContain("oauth-state=opaque");
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(signInWithOAuth2).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { providerId: "voss", callbackURL: "/api/operator/sign-in" },
      asResponse: true,
    });
  });

  it("returns only the authenticated app user ID after the callback", async () => {
    getSessionUser.mockResolvedValue({
      id: "real-vauth-app-id",
      name: "private",
    });
    const response = await loader({ request: request() } as never);
    expect(await response.json()).toEqual({ userId: "real-vauth-app-id" });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(signInWithOAuth2).not.toHaveBeenCalled();
  });

  it("honors the paused sign-in gate", async () => {
    env.VAUTH_SIGN_IN = "off";
    const response = await loader({ request: request() } as never);
    expect(response.status).toBe(503);
    expect(signInWithOAuth2).not.toHaveBeenCalled();
  });

  it.each([
    "bad-response",
    "unsafe-destination",
    "provider-failure",
    "session-failure",
  ])("handles %s without exposing provider details", async (kind) => {
    signInWithOAuth2.mockResolvedValue(
      Response.json({
        url: kind === "unsafe-destination" ? "http://untrusted.example" : 23,
      }),
    );
    if (kind === "provider-failure")
      signInWithOAuth2.mockRejectedValue(
        new Error("sensitive provider detail"),
      );
    if (kind === "session-failure")
      getSessionUser.mockRejectedValue(new Error("sensitive database detail"));
    const response = await loader({ request: request() } as never);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("sensitive");
  });
});
