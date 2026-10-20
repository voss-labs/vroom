# V Rooms

Anonymous, real-time campus rooms built by VOSS Labs. A key held in one browser profile
gets a stable handle. Students provide no account, name, email or phone number;
clearing site data loses the handle; another browser profile gets its own identity. V Auth identifies
moderators only.

Status: v1 in progress. Scope is in `.preset/PRODUCT.md`, with later accepted
changes in `/vrips/`. VRIP-12 fixes the five-room list, VRIP-13 defines device
anonymity, VRIP-15 sets 48-hour message retention, and VRIP-16 moves moderation
to the terminal.

## Quick start

Use Node 20+, a Cloudflare account, Neon Postgres and a registered V Auth client.

```sh
npm ci
cp .env.example .env
cp .env .dev.vars
npm run db:push
npm run db:migrate
npm run dev
```

Fill the environment files before running. `db:push` is for an empty database
only. On an existing database run `npm run db:migrate`; never push the schema
because it removes migration checks and the ledger.

```sh
npm run typecheck
npm test
npm run format:check
npm run build
npm run deploy
```

Deploy through `npm run deploy`, which builds before Wrangler reads the generated
Worker configuration.

The retained-message reporting repair requires migration
`0004_retained_report_author.sql`. The authorized deployment step must apply
`npm run db:migrate` before merging that repair: Cloudflare automatically deploys
merged main, and the new code requires the new column. Contributors must not run
production migrations themselves. Do not use `db:push` on an existing database.
A code-only rollback to older report readers can hide reports without a linked
account, even though evidence remains stored. Prefer a forward code repair; do
not reverse nullable schema or delete reports to make an old build work.

The optional PostgreSQL regression suite exercises policy-drain rollback and
concurrent retries using the actual compiled statement. Point it only at a
disposable local cluster with a Unix socket and TCP disabled; it creates and
removes an isolated test schema and never reads `DATABASE_URL`.

```sh
VROOM_POLICY_PG_SOCKET=/absolute/socket-directory VROOM_POLICY_PG_PORT=5432 npx vitest run --config vitest.postgres.config.ts
```

## How it works

One Cloudflare Worker serves React Router and WebSocket upgrades. Each room has
a Durable Object using SQLite and WebSocket Hibernation. It stores enforcement
state and messages, which expire after 48 hours. Neon holds device-key hashes,
moderator members, retained reports and the audit trail. A report snapshots the
message before expiry; its evidence and audit records outlive room messages.

The non-extractable private key persists in origin-local IndexedDB. Tabs and
reloads in one profile share it; simultaneous first tabs commit one winning key.
A fresh proof can renew the 30-day HttpOnly, SameSite=Lax session cookie after
expiry without changing the handle. HTTPS cookies are Secure. Private browsing
may make storage temporary or unavailable; failure never selects a default user.
This identifies a browser profile, rather than a physical device or person.

Public room requests accept device sessions only. A V Auth session cannot replace
a device key. The socket JWT carries a handle and a room and is sent in the
WebSocket subprotocol. There is no identity reveal or mapping from student handles
to real people. Cloudflare sees IP addresses in transit; V Rooms does not store
them as student identity.

## Moderation

Run the terminal from this repository. The laptop needs `VROOMS_ORIGIN` and
`MOD_SCRIPT_TOKEN` in its environment or local `.env`. The Worker needs the same
token and `MOD_SCRIPT_MEMBER_HANDLE`, naming a current, active V Auth moderator
member. Never pass the token as an argument. Use HTTPS; HTTP is accepted only for
loopback development. Origins with credentials, paths, queries or fragments are
rejected, and the client refuses redirects.

```sh
npm run manage
npm run mod
npm run mod -- reports
npm run mod -- reports 1
npm run mod -- accounts
npm run mod -- audit
npm run mod -- status
npm run mod -- close "Incident response"
npm run mod -- open
npm run mod -- suspend quiet-ibex "Repeated harassment"
npm run mod -- restore quiet-ibex
npm run mod -- delete <report-id>
npm run mod -- dismiss <report-id>
```

No-argument commands open interactive menus in a terminal. Lists use zero-based
pages of 25 records. Reports display retained snapshots and reasons and offer
message deletion, suspension and dismissal; accounts support suspension and
restoration. Interactive writes display their target and require confirmation.
Explicit commands execute directly and remain suitable for scripts.

Reports retain the message's author label and text independently of its account.
Legacy labels such as `Local Dev` remain reportable evidence without becoming
accounts. A report without a current linked account can still be reviewed,
deleted or dismissed; the CLI explains why suspension is unavailable. Only a
real linked member can be suspended from a report.

Reports drain automatic policy flags before reading the stored queue. If a room
cannot be drained, the queue remains readable with an incomplete-drain warning.
Status reports each room's reachability separately. All-room commands may already
have enforced in reachable rooms when another fails; a failure does not mean
rollback. Check status and retry after restoring reachability. Neon and audit
success writes follow completed Durable Object enforcement.

There is no browser moderation console. Student Report, Block and message
withdrawal remain in the room. Moderators must check the queue deliberately;
this change does not add an alert service. The bearer acts as one designated
moderator, so it does not distinguish people sharing that credential. Rotate it
when access changes.

## Moderator bootstrap

Existing designated moderator rows and credentials continue working. For a new
moderator, first create a real local V Auth app account through the configured
OAuth flow. With `VAUTH_SIGN_IN=on` on the Worker, visit
`https://<your-vroom-origin>/api/operator/sign-in` in a browser and complete V Auth.
The endpoint preserves the configured OAuth state/cookies and returns only your
local app `userId` after the callback. It provides no moderation interface and
grants no role. If sign-in is paused, an operator must explicitly reopen it in
the deployment configuration to create a new account.

Using database administration credentials locally:

```sh
npm run promote -- <V-Auth-app-user-id>
npm run promote -- --list
npm run promote -- <V-Auth-app-user-id> --revoke
```

Promotion requires an existing app user with a `voss` OAuth account. It creates
that user's separate moderator member if needed, assigns a unique handle and
then grants the role. It never fabricates an auth user or accepts an email. A
suspended role remains inert; deleted members are refused. Set the returned
handle as the Worker's `MOD_SCRIPT_MEMBER_HANDLE`. Promotion is the out-of-band
role-grant exception; operational moderation always uses the authenticated HTTP
API, without a database credential on the moderation laptop.

## Contributing

Open an issue, then build it. Start at
[voss-labs/first-contributions](https://github.com/voss-labs/first-contributions)
if you are new to contributing. Read `AGENTS.md` for repository constraints.

## License

TBD.
