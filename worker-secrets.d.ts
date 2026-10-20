/**
 * Secrets are set with `wrangler secret put` and locally in `.dev.vars`, so
 * they never appear in wrangler.jsonc and `wrangler types` cannot see them.
 * This file is the committed half of the environment contract — the generated
 * `worker-configuration.d.ts` covers the vars and the bindings.
 *
 * Keep it in step with `.env.example`.
 */

declare namespace Cloudflare {
  interface Env {
    DATABASE_URL: string;
    DIRECT_URL: string;
    BETTER_AUTH_URL: string;
    BETTER_AUTH_SECRET: string;
    APP_JWT_SECRET: string;
    /** Signs device-key challenges and student session cookies (VRIP-13). */
    DEVICE_SESSION_SECRET: string;
    VAUTH_CLIENT_ID: string;
    VAUTH_CLIENT_SECRET: string;
  }
}

declare namespace NodeJS {
  interface ProcessEnv {
    DATABASE_URL: string;
    DIRECT_URL: string;
    BETTER_AUTH_URL: string;
    BETTER_AUTH_SECRET: string;
    APP_JWT_SECRET: string;
    DEVICE_SESSION_SECRET: string;
    VAUTH_CLIENT_ID: string;
    VAUTH_CLIENT_SECRET: string;
    /** Used only by scripts/mod.ts, which runs on a laptop rather than the Worker. */
    VROOMS_ORIGIN: string;
  }
}

export {};
