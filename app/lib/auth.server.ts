import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";

import { getDb, schema } from "~/db";

/** first.last@vit.edu.in -> "First Last" */
function deriveNameFromEmail(email: string): string {
  const local = email?.split("@")[0] ?? "";
  return (
    local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ") || email
  );
}

/**
 * Built lazily behind a Proxy, and this is not optional.
 *
 * Module scope on Workers runs at isolate boot — before any request exists and
 * therefore before secrets are injected. Constructing here yields undefined
 * secrets in production while `wrangler dev` hides it. The instance is cached,
 * so better-auth's router is still built once per isolate rather than per
 * request.
 */

let instance: ReturnType<typeof build> | null = null;

function getAuth() {
  return (instance ??= build());
}

export const auth = new Proxy({} as ReturnType<typeof build>, {
  get(_target, prop) {
    const target = getAuth();
    const value = Reflect.get(target, prop);
    return typeof value === "function" ? value.bind(target) : value;
  },
});

function build() {
  return betterAuth({
    baseURL: process.env.BETTER_AUTH_URL,
    secret: process.env.BETTER_AUTH_SECRET,

    database: drizzleAdapter(getDb(), {
      provider: "pg",
      schema,
      // neon-http cannot open interactive transactions. Leaving this on
      // silently breaks user creation.
      transaction: false,
    }),

    // V Rooms holds no credentials. V Auth is the only door, and scrypt does
    // not fit the Workers free-tier CPU budget.
    emailAndPassword: { enabled: false },

    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },

    account: {
      accountLinking: {
        enabled: true,
        // V Auth verifies the mailbox with a one-time code and enforces the
        // @vit.edu.in gate, which is exactly what trustedProviders means.
        // Adding a provider that does not verify email reopens account takeover.
        trustedProviders: ["voss"],
        allowDifferentEmails: false,
      },
    },

    plugins: [
      // TODO: Re-enable auth
      /*
      genericOAuth({
        config: [
          {
            providerId: "voss",
            discoveryUrl: process.env.VAUTH_DISCOVERY_URL!,
            clientId: process.env.VAUTH_CLIENT_ID!,
            clientSecret: process.env.VAUTH_CLIENT_SECRET!,
            scopes: ["openid", "profile", "email"],

            // MUST be true. It defaults to false on the client while V Auth
            // requires OAuth 2.1 PKCE, so without this every sign-in fails at
            // the token endpoint.
            pkce: true,

            // Reject a token whose issuer is not the one discovery advertised.
            requireIssuerValidation: true,

            // `name` is optional in OIDC but NOT NULL here. When V Auth sends
            // no name claim the insert fails with `name_is_missing` — after the
            // OAuth dance has already succeeded, so the user is bounced back to
            // the login page with no explanation.
            mapProfileToUser: (profile) => ({
              name: profile.name?.trim() || deriveNameFromEmail(profile.email),
            }),
          },
        ],
      }),
      */
    ],
  });
}

export interface SessionUser {
  id: string;
  name: string;
}

/** Returns null rather than throwing, so callers decide the redirect. */
export async function getSessionUser(
  request: Request,
): Promise<SessionUser | null> {
  // TODO: Re-enable auth
  return { id: "dev-user", name: "Local Dev" };
  /*
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) return null;
  return { id: session.user.id, name: session.user.name };
  */
}
