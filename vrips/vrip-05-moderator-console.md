# VRIP-05: Ship a moderator console in v1, reversing the out-of-scope decision

**Status:** Superseded in part by VRIP-16 (browser interface); enforcement constraints remain
**Date:** 2026-08-12
**Author:** Harshal More

## Context

`.preset/PRODUCT.md` put "a moderator dashboard or any moderation UI" in the v1
out-of-scope list, with moderator actions reachable only from a script. That was
coherent when a report also fired an out-of-band alert: the alert was the queue, and
the script was the remedy.

The alert was then cut from v1. Reports still write a record, but nothing pushes
anywhere, so the queue became a table nobody looks at. A script cannot show you what
is waiting, only act on something you already know about. The combination of no
alert and no surface means a report can sit unseen indefinitely, which fails the one
risk the product cannot afford.

Response time is the constraint, and a psql session at 2am is not a response path.

## Decision

Ship a moderator console in v1. It carries the report queue, account suspension, the
kill switch, and the audit trail. It is a route inside the same app (React Router on one Worker, per VRIP-06
which came later), gated on
a moderator role checked server-side, not a separate deployment.

Three properties are part of the decision, not implementation detail:

- The console is reachable only by a moderator. The navigation entry does not render
  for a student, and every action re-checks the role on the server. Hiding the link
  is presentation; the check is the control.
- A reveal is reachable only from a report, never as a free lookup. The accounts
  table has no email column. This is VRIP-04's binding rule expressed in the
  interface: an identity resolution always carries the message that justified it.
- The kill switch is Durable Object state the console and a script can both flip. It
  is not an environment variable, because an environment variable needs a redeploy
  and is therefore useless as an emergency control.

## Consequences

- Win: a moderator can see the queue, which is the difference between a report being
  filed and a report being handled.
- Win: the audit trail is written by the same path that performs the action, so it
  is complete for anything done through the console.
- Win: the script path still exists and is unchanged, so the console being down does
  not remove the remedy.
- Cost: v1 grows by a route, a role check, and four tables of interface. This is a
  real scope increase on a product whose whole discipline is staying small.
- Cost: a console makes revealing an identity easier, and easier is not obviously
  good. The binding rule and the audit row are what keep it deliberate.
- Risk: role gating is the entire access control. A missing server-side check on one
  action exposes the mapping to any authenticated student. Every action re-checks.
- Risk: whoever holds the database connection string can still bypass the console and
  its audit trail entirely. VRIP-04 records this; the console does not fix it.
- Precludes: nothing. A dashboard remains out of scope; this is a working surface,
  not analytics.

## Alternatives considered

- Keep script-only and restore the alert webhook: rejected for v1 because the alert
  was cut deliberately and re-adding it brings a delivery integration with it. Worth
  revisiting later as a complement to the console, not a replacement.
- A separate admin deployment: rejected as disproportionate at this size. One app,
  one role check, one audit table.
- Read-only console, actions still by script: rejected. Splitting seeing from acting
  means the fastest available response is still a terminal, which is the problem
  being solved.

## Implementation notes

The approved interface prototype lives at `prototype.html` in this repo and is the
reference for both surfaces. It is static HTML that reproduces the design language;
the build uses shadcn components, matching VERP's `components.json`.

- Chat is dense inline rows, `handle: message`, alternating tint, actions on hover.
- Handles are coloured from a fixed eight-colour set held at matched lightness. The
  orange-to-red band is excluded: brand orange means "you", muted red means "bad".
  This follows the rule recorded in vask's `internal/tui/style.go`.
- Palette is VOSS brand orange `#fb7a3c` on vask's stone neutrals.
- The console uses the shadcn data-table pattern: filter input, column toggle,
  checkbox selection, sortable headers, a row overflow menu, and a selection footer.
