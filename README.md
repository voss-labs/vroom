# V Rooms

A Anonymous, real-time conversation for verified VIT students. Built by VOSS Labs.

WhatsApp connects people who already know each other. V Rooms lets you talk to the
college you have not met yet. You log in with V Auth, you get a handle, and you are
already in the room. No joining, no invite, no knowing anyone first. Other students
see only your handle, never your name, your email, or your division.

Status: v1 in progress. Product scope is in `.preset/PRODUCT.md`, decisions are in
`/vrips/`, and the approved interface is `prototype.html`.

## Quick start

Prerequisites: Node 20+, a Cloudflare account (the free plan is enough), a Neon
project, and a V Auth client registered in `voss-auth`.

```
git clone <repo>
cd v-rooms
npm install
cp .env.example .env           # fill in the values
cp .env .dev.vars              # wrangler reads secrets from here in dev
npm run db:push                # drizzle-kit carries the schema
npm run db:migrate             # numbered SQL carries the CHECKs and triggers
npm run dev                    # app, worker and durable object together
```

Checks:

```
npm run typecheck              # wrangler types + react-router typegen + tsc
npm test                       # unit tests on Node, worker tests in workerd
```

Deploy:

```
npm run deploy                 # build then wrangler deploy, one Worker
```

Never run bare `wrangler deploy`: the Vite plugin bakes `wrangler.jsonc` into
`build/server/`, so deploying without building first ships the previous config
with no warning.

## How it works

```
browser ──► V Auth (OIDC) ──► app token (handle + room only)
   │
   └── WebSocket ──► Worker (validates the token on the upgrade, before accept)
                        │
                        └──► Room Durable Object (holds the sockets, broadcasts,
                             stores messages in its own SQLite)
                        │
                        └──► Neon (accounts, members, reports, moderation audit)
```

One Durable Object per room means the object itself is the fanout point, so there
is no Redis and no pub/sub layer. Message history lives inside the object next to
the code that serves it. Anything that needs querying across rooms — accounts,
reports, the audit trail — lives in Neon.

The token handed to the browser carries a handle and a room, and nothing else. The
Worker and the Durable Object never receive an email or a V Auth account id, so the
realtime layer cannot leak an identity it was never given.

See `.preset/ARCHITECTURE.md` for the full design and `/vrips/` for the reasoning
behind each part of the stack.

## Moderation

Anonymity in V Rooms exists between students, not between a student and the
platform. Every message is attributable server-side to a V Auth account.

Moderators get a console inside the app, reachable only with a moderator role that
is re-checked on the server for every action. Resolving a handle to a real person is
possible, and it is deliberately awkward: it can only be done from a specific report,
so the reason is always recorded alongside the result. The database enforces this —
an audit row claiming a reveal with no report attached is rejected outright.

This is not an uncontrolled anonymous board, and it is not intended to become one.
If you find abuse, use the report button.

## Contributing

Missing a feature? Open an issue, then build it. That is the intended path here, not
a formality — most of the v1 out-of-scope list is deliberately left for student
contributors. New to open source, start with
[voss-labs/first-contributions](https://github.com/voss-labs/first-contributions).

Read `AGENTS.md` before your first PR. It carries the constraints that are easy to
violate accidentally, particularly around Durable Objects, the identity mapping, and
auth.

## License

TBD.
