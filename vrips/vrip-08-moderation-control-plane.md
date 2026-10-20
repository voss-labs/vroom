# VRIP-08: One moderation module, two front doors, and where enforcement lives

**Status:** Accepted; two-interface requirement superseded by VRIP-16
**Date:** 2026-08-12
**Author:** Harshal More

## Context

VRIP-05 put the console in v1 and kept the script path alongside it, on the
grounds that the console being down must not remove the remedy. It also fixed
the kill switch as Durable Object state rather than an environment variable,
because an environment variable needs a redeploy and is useless as an emergency
control.

Two things follow that VRIP-05 did not decide, and both are the kind of thing
that gets decided badly by accident.

The first is duplication. A console route and a CLI script that each perform
suspension will drift, and the one that drifts is the one used at 2am under
pressure. VRIP-05's own risk section names the failure: "a missing server-side
check on one action exposes the mapping to any authenticated student". Two
implementations means two places to miss it.

The second is ordering. Every moderator action touches two stores — Neon holds
the record and the audit trail, the Durable Object holds the state that actually
stops someone posting. There is no transaction across them. Whichever store is
written second can fail, and the two possible failures are not equivalent: an
enforcement that happened without an audit row is a gap in the record, while an
audit row for an enforcement that never happened is a lie in the record. VRIP-04
makes the audit row the only real control over identity resolution, so guessing
at this is not acceptable.

## Decision

All moderator actions — from the console and from the script — go through one
module, `app/lib/moderation.server.ts`, which re-checks the moderator role
against Neon before doing anything. The console reaches it through a React
Router action carrying a better-auth session; the script reaches it through
`POST /api/mod/:action` with a bearer `MOD_SCRIPT_TOKEN` that resolves to a
designated moderator row. Enforcement state — kill switch, suspensions, message
deletion — lives in the Durable Object and is written first; the Neon record and
audit row are written second. The single exception is identity resolution, where
the audit row is written first and the read happens only if that write succeeded.

## Consequences

- Win: one code path, so the server-side role check exists once and cannot be
  present in the console and missing in the script.
- Win: the remedy with a deadline lands first. Closing the room, suspending an
  account and deleting a message take effect on the next frame regardless of
  what Neon is doing.
- Win: a reveal cannot happen without its audit row, because the row is the
  precondition rather than the consequence. Combined with a database CHECK that
  a `reveal` row must carry a `report_id`, VRIP-04's binding rule is enforced by
  the schema rather than by discipline.
- Win: the script keeps working when the console is broken, and the audit trail
  records which door was used (`actor_kind`).
- Cost: `MOD_SCRIPT_TOKEN` is a long-lived bearer secret with full moderator
  power and no session, no expiry and no second factor. It is a genuinely worse
  credential than a login, and it exists because VRIP-05 requires the script.
- Cost: the audit row for a script action names a designated moderator row
  rather than a person, so "who ran it" is only as good as who holds the token.
- Risk: if the Neon write fails after enforcement succeeded, the action took
  effect and is unrecorded. The module surfaces this as a loud error rather than
  swallowing it, but the window exists and cannot be closed without a
  distributed transaction the product does not warrant.
- Risk: if the Durable Object is unreachable, enforcement fails and nothing is
  written. That is the correct behaviour — a suspension that only exists in Neon
  would show as applied in the console while the account kept posting — but it
  means the console's remedy has a hard dependency on the room being reachable.
- Precludes: adding a moderator action that only touches Neon and forgetting it
  needs a Durable Object leg. Anything that changes what a student can do has to
  go through the object.

## Alternatives considered

- Console and script as separate implementations: rejected. It doubles the
  surface on which the role check can be missed, which VRIP-05 already names as
  the risk that matters most.
- Script talks to the Durable Object directly with its own token: rejected. It
  would bypass the audit trail entirely, which is the one thing the script path
  must not do.
- Neon as the source of truth for suspension, read by the Durable Object on
  connect: rejected because it puts a network hop into the hot path and, worse,
  it does nothing about an already-open socket. Enforcement has to be able to
  close a connection, so it has to live where the connections are.
- Audit-first for every action: rejected. It converts the enforcement failure
  case into a false record, and the audit trail is worth more when its rows are
  true than when they are complete.
- Write the audit row twice, as intent and then confirmation: rejected as
  disproportionate at 10-20 concurrent users and a handful of actions a week.
  Reconsider if the audit trail ever has to satisfy someone outside VOSS.

## Implementation notes

- Actions: `reveal`, `delete_message`, `suspend`, `restore`, `dismiss_report`,
  `set_room_state`. Each takes an actor and returns a structured error rather
  than throwing raw database errors at the caller.
- The console never receives an email in a loader payload. `reveal` is a POST
  that returns the address for exactly one report, and the client holds it in
  component state only.
- `app/lib/identity.server.ts` exports the single function that resolves a
  pseudonym to a real account (VRIP-04). `moderation.server.ts` is its only
  caller, and it passes the `report_id` that justifies the resolution.
- The script is `scripts/mod.ts`, run with `tsx`, reading `MOD_SCRIPT_TOKEN` and
  the deployment origin from the environment. It prints the audit row it caused.
