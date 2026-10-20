# V Rooms

Anonymous, real-time campus rooms built by VOSS Labs. A key held in one browser profile
gets a stable handle. Students provide no account, name, email or phone number;
clearing site data loses the handle; another browser profile gets its own identity.
Moderation uses temporary database-authorized CLI sessions (VRIP-18).

Status: v1 in progress. Scope is in `.preset/PRODUCT.md`, with later accepted
changes in `/vrips/`. VRIP-12 fixes the five-room list, VRIP-13 defines device
anonymity, VRIP-15 sets 48-hour message retention, and VRIP-16 moves moderation
to the terminal.

## Quick start

Use Node 20+, a Cloudflare account and Neon Postgres. V Auth sign-in stays off.

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

The current code requires migrations `0004_retained_report_author.sql` and
`0005_cli_sessions.sql`, applied in order with `npm run db:migrate` after rollout
approval. Cloudflare automatically deploys merged main; apply pending migrations
before merge. Contributors must not run production migrations themselves. The
last read-only production check found only 0001-0003 applied; verify the live
ledger again before rollout. This implementation grants no production rollout
authority. Do not use `db:push` on an existing database. A code rollback must
preserve retained report evidence and the session authority boundary.

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
temporary CLI sessions, retained reports and the audit trail. Historical auth
records remain stored. A report snapshots the
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

Run the terminal from this repository with `DATABASE_URL` and `VROOMS_ORIGIN` in
the environment or local `.env`. Inherited environment values take precedence.
The database credential must have permission to register a CLI session: read-only
access is insufficient. Never pass credentials as arguments. HTTPS is required
except for HTTP loopback development. Origins with credentials, paths, queries
or fragments are rejected; redirects are refused.

Each invocation registers a random 15-minute, origin-bound bearer and stores
only its SHA-256 hash. The Worker proves access through an authenticated status
request before the first operation and rechecks the complete live credential at
each shared operation. There is no V Auth, member, cookie or legacy token fallback.
A missing `cli_sessions` table requires an approved migration; the CLI never
migrates automatically.

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
withdrawal remain in the room. Operators must check the queue deliberately;
this change adds no alert service. Mutations audit `CLI session <id>`, with no
member or named-human attribution. Report status and resolution time establish
resolution; `resolved_by` is NULL for CLI actions. Historical actor handles and
automatic system actions retain their meaning.

Sessions refresh through database authority before an action when fewer than
30 seconds remain. An idle menu sends no keepalive; the next action renews even
an expired session if its row remains unrevoked. Revoked or missing rows stop the
process. Exit and cancellation attempt bounded revocation; a crash is bounded
by fixed expiry. Registration cleans up at most 100 rows expired or revoked at
least seven days ago, preserving audit snapshots. Very old idle sessions may
need restarting after cleanup.

No mutation is automatically replayed after a 401, timeout or partial failure.
Inspect room status and audit before deciding whether to retry an uncertain
action. Database and HTTP failures return fixed credential-safe messages.

Migration 0005 initially reserves session registration to its owner and revokes
PUBLIC and named-role default grants on the new table. A future INSERT grant is
a grant of full moderation authority. Inspect inherited role membership and
default grants before rollout. A restricted Worker role needs SELECT only on
`cli_sessions`, no session writes, TRIGGER privilege or owner membership; other
app tables retain their required rights. Existing shared owner credentials do
not provide that separation. The database owner remains the trust root and can
issue another session after revocation or bypass database guards. No role or
credential deployment is part of this change.

## Contributing

Open an issue, then build it. Start at
[voss-labs/first-contributions](https://github.com/voss-labs/first-contributions)
if you are new to contributing. Read `AGENTS.md` for repository constraints.

## License

TBD.
