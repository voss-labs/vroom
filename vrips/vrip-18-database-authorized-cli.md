# VRIP-18: Authorize moderation CLI sessions through database access

**Status:** Accepted
**Date:** 2026-10-20
**Author:** Harshal More
**Supersedes:** VRIP-13's V Auth moderator requirement; VRIP-16's designated
V Auth member and long-lived bearer model; the corresponding VRIP-08 script
credential and actor-binding rules

## Context

The CLI-only interface from VRIP-16 still needs MOD_SCRIPT_TOKEN and
MOD_SCRIPT_MEMBER_HANDLE bound to an active V Auth moderator. Boss explicitly
rejects V Auth dependence anywhere in Vroom moderation and keeps VAUTH_SIGN_IN
off. He is the sole holder of database administrator credentials and accepts
CLI-session attribution rather than a named-human audit identity.

V Auth's local administration scripts demonstrate an environment-authorized
operator experience. Their direct SQL mutation path cannot be copied: Vroom's
Durable Objects enforce suspensions, live deletions and room closure. SQL-only
moderation would leave live state inconsistent and bypass the shared audit path.
A nonempty DATABASE_URL or SELECT 1 proves neither administrative permission nor
server-side authorization; an HTTP caller can bypass any local CLI check.

## Decision

The local CLI uses DATABASE_URL to register a random, opaque, origin-bound session
in Neon and sends only that temporary bearer to VROOMS_ORIGIN. The Worker
revalidates its stored hash, origin, database-clock expiry and revocation for every
shared moderation operation and preserves Durable Object enforcement and audit.
The sole authority is permission to register this session, with no V Auth, member,
legacy token or cookie fallback; audit identifies the CLI session, not a person.

## Consequences

- Win: local setup is DATABASE_URL plus VROOMS_ORIGIN; no operator OAuth, promotion
  or manual bearer secret. VAUTH_SIGN_IN stays off.
- Win: moderation retains the Worker/DO path, policy draining, server-side live
  authorization, partial-failure reporting and report evidence.
- Win: no synthetic student, V Auth user or moderator member is created. Student
  device-key identity and all anonymity constraints remain intact.
- Cost: possession of session-registration DB privileges grants full moderation
  authority. This is a deliberate trust-root decision, not a harmless health check.
- Cost: shared database credentials cannot establish named-human accountability.
  Boss accepts session-only attribution. Audit cannot prove which human ran SQL.
- Risk: an exposed session is a bearer credential until revocation or its fixed
  15-minute expiry. Exposed DB owner credentials can issue more sessions or alter
  schema directly; session revocation is not database credential revocation.
- Limitation: Worker SELECT-only access on the session table can separate runtime
  from administrator authority, but existing shared owner credentials do not
  provide that separation. Do not claim otherwise without actual grant changes.
- Constraint: no direct SQL moderation, automatic mutation replay, HTTP credential
  exchange, identity reveal, stored DB credential, token logging or browser auth
  fallback. No new moderation feature or public identity model is introduced.

## Alternatives considered

- Keep the designated V Auth moderator: rejected by Boss because it retains the
  dependency and requires operator bootstrap even with V Auth sign-in disabled.
- Trust local DB health checks and retain an unrelated bearer: rejected because
  the Worker cannot verify the claimed check and the static secret remains a
  second administrator credential with its own lifecycle.
- Send DATABASE_URL to the Worker: rejected because it exposes broad database
  credentials to HTTP requests when a temporary opaque session suffices.
- Mutate moderation tables directly: rejected because Durable Objects hold active
  enforcement state and Neon alone cannot close sockets or reopen/close rooms.

## Implementation contract

[CLI-DB-CONTRACT.md](../.preset/CLI-DB-CONTRACT.md) defines the schema, lifecycle,
API, actor shape, migration and tests. Its concrete minimum is:

- One independent cli_sessions table with UUID, unique SHA-256 token hash,
  canonical origin, database-stamped creation/15-minute expiry and revoked_at.
  Credential and lifetime attributes are immutable; revocation is one-way.
- Registration requires an actual permitted INSERT, with PUBLIC denied. Read-only
  credentials fail. Only a hash leaves CLI memory for storage; DATABASE_URL never
  enters the Worker request. Ordinary runtime validation requires only SELECT.
- Refresh generates fresh token material through direct DB authority, atomically
  registers it and revokes its predecessor. Expired menu sessions can renew;
  revoked/missing sessions stop the process. Exit attempts bounded revocation;
  crashes are bounded by absolute expiry. Bounded cleanup removes only terminal
  records at least seven days old without deleting audit evidence.
- The shared operation guard uses the full session id/hash/origin, not a trusted
  actor id or a cached lookup. Auth failures occur before business side effects.
  Mutations already admitted cannot be undone by a concurrent revocation.
- Human audit keeps actor_kind=script, actor_member_id=NULL and snapshots the
  validated session UUID in details.cliSessionId. Report resolution keeps its
  nullable resolved_by member link NULL; status/resolved_at plus linked audit
  express the action. Historical and automatic actors retain their meaning.
- Add migration 0005 after 0004; preserve existing migrations, historical auth
  rows, audit rows and identity CHECKs. Remove obsolete operator sign-in and
  promotion bootstrap, MOD_SCRIPT_TOKEN and MOD_SCRIPT_MEMBER_HANDLE requirements.
  Update current AGENTS.md and setup docs; earlier accepted XIPs remain historical.

## Authorization and rollout boundary

Accepted from Boss's explicit direction recorded in preset ledger 33. Acceptance
authorizes implementation through review and QA and grants no new production
authority. Prior scoped authorization to restore mellow-wolf remains in force;
production migration and merge-triggered deployment are not yet authorized.
PR83 is already merged, but the last read-only production check still lacked migration 0004.
A future rollout must separately verify the ledger and obtain authorization for
any pending migrations in order. Use db:migrate, never drizzle-kit push on data.

## Evidence

- [Local research](../.preset/research/database-authorized-cli.md): V Auth script
  behavior, current Vroom authorization and existing nullable audit member links.
- [PostgreSQL privileges](https://www.postgresql.org/docs/17/ddl-priv.html):
  connection/read access, write grants and object ownership are distinct.
- [PostgreSQL trigger rules](https://www.postgresql.org/docs/17/sql-createtrigger.html):
  BEFORE triggers can stamp and reject row attributes.
- [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html):
  opaque random credentials and server-side expiry; 15 minutes is our design choice.


## Implementation notes

Implemented 2026-10-20. Migration 0005 supports migration-only and schema-first
empty setup, reserves initial issuance to its owner by removing PUBLIC and named
default grants, and database-stamps fixed lifetime and one-way revocation. Shared
operations requery full live credentials before target lookups and enforcement.
The CLI registers/proves/renews/revokes bounded sessions through the installed
Neon HTTP driver, and no mutation is automatically replayed after failure.
Session audit snapshots survive credential cleanup; CLI report resolution uses
NULL resolved_by with canonical status/time and linked session audit.

Verification: 539 unit/Worker tests passed with two existing skips; 37 isolated
local PostgreSQL tests passed; typecheck, format check and production build passed.
Local PostgreSQL uses synthetic fixtures and does not prove Neon or production
rollout. Historical auth tables remain. No production migration, deployment or
runtime-role separation was performed. Independent review and QA follow.
