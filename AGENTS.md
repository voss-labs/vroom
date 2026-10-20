# AGENTS.md

Local rules for this repo. These override generic guidance.

## Project

V Rooms — an anonymous, real-time campus conversation for VIT students (VRIP-13).
Built by VOSS Labs. Read `.preset/PRODUCT.md` before proposing any feature; the
out-of-scope list there is deliberate and is not a backlog to quietly work through.

## Process

This repo is run through the preset MCP server on the `ai-native-team` archetype.

- `.preset/state.json` holds only `project_id` and `repo_key`. The live phase comes
  from `preset.get_state`, never from a file.
- Process artifacts live in `.preset/`. Product source code lives in the repo proper.
- Do not skip a phase and do not hand-write an artifact to unlock the next one.
- Read `preset.get_decisions` before designing or reviewing.

## Decision records

This project uses XIPs (see `/vrips/`) for non-trivial decisions. Before working in
an area covered by an XIP, read it. When proposing a significant change, draft a new
XIP first rather than changing the code and explaining afterwards.

## Stack

Decided in VRIP-03. Do not substitute parts of it without a superseding XIP.

- One Cloudflare Worker serves everything. React Router v8 in framework mode
  renders the student rooms, and the Durable Object class is
  exported from the same Worker entry (VRIP-06, superseding VRIP-03's Pages line)
- Moderation: interactive terminal and explicit commands call the authenticated Worker
  API; no browser console (VRIP-16).
- Styling: Tailwind + shadcn, mobile-first, matching voss-auth's components.json
- Realtime: one Durable Object per room on the WebSocket Hibernation API
- Message history: Durable Object SQLite storage
- Users, reports, moderation audit: Neon Postgres via `@neondatabase/serverless`
- Auth: students prove a browser-held device key and receive a short-lived app JWT
  (VRIP-13). The moderation CLI registers temporary database-authorized sessions
  (VRIP-18); V Auth sign-in stays off.
- No Redis. See VRIP-03 for why.

## Hard constraints

- Durable Object classes must use a `new_sqlite_classes` migration. Key-value backed
  classes do not work on the Workers free plan.
- Under WebSocket Hibernation the object is evicted from memory. Persist connection
  state with `serializeAttachment()` / `deserializeAttachment()` and restore via
  `ctx.getWebSockets()`. Getting this wrong makes sockets appear to die after
  seconds and is the single most likely source of a confusing bug here.
- Use Neon's serverless HTTP driver, not a TCP `pg` client. Workers cannot hold TCP
  Postgres connections.
- Validate the app JWT on the WebSocket upgrade request, before the upgrade is
 accepted. Auth checks come before any business logic.
- A student is a device key and nothing else. Store only the sha256 of the
 public key: never an email, a name, an IP address, or anything that links a
 handle to a person. The `members_one_identity` CHECK rejects a row that has
 both a key hash and a V Auth account (VRIP-13).
- Moderation authority is permission to INSERT a temporary CLI session, not a
  member role or V Auth account (VRIP-18). Store only the token hash and origin;
  never log or audit bearer tokens, database URLs, or historical auth emails.
- Report, block, suspend, and the kill switch ship in v1. They are not features to
  defer to a later phase.
- The kill switch is Durable Object state, never an environment variable. An env var
  needs a redeploy and is useless as an emergency control (VRIP-05).
- The app token goes in the WebSocket subprotocol, never the query string. A query
  string writes a bearer credential into every access log it passes (VRIP-07).
- There is no identity reveal. Do not add one: there is nothing behind a handle
 to reveal, and building a way to find out would undo VRIP-13. The old
 `reveal_must_be_bound` CHECK stays so historical audit rows remain valid.
- Every shared moderation read and mutation rechecks session id, token hash,
  exact origin, expiry and revocation against database time before business logic.
  CLI audit identifies the session with no member or named-human attribution.
  Public student routes accept only device sessions; a V Auth session must never replace a device identity.
- Rate limiting is keyed per pseudonym, not per socket. Two tabs must not double
 anyone's budget.
- Never run `drizzle-kit push` against a database that already has data. It
 drops the `_migrations` ledger and every CHECK the SQL migrations add. On an
 existing database run `npm run db:migrate` only.

## Conventions

- Files 200-400 lines maximum. Split when bigger.
- Explicit error handling in every public function.
- Every user-facing flow has loading, error, and empty states. The empty state of
  Campus Live matters more here than in most products.
- Mobile-first. Layout starts at 320px. Touch targets at least 44x44 CSS pixels.
- Tests cover the happy path and the error paths.
- No emojis anywhere: code, comments, docs, commits, READMEs.
- No `Co-Authored-By` lines in commits.

## Contributing

Feature requests from students arrive as GitHub issues and are built by student
contributors. That is the intended path, not an exception to it. Point newcomers at
`voss-labs/first-contributions` first.
