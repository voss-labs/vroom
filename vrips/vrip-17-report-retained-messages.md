# VRIP-17: Report retained messages independently of account availability

**Status:** Proposed for the approved repair scope
**Date:** 2026-10-20
**Author:** Harshal More
**Amends:** VRIP-08, VRIP-13, VRIP-15, VRIP-16

## Context

A valid device member can see a retained message whose author has no Neon member.
The previous development build left Local Dev messages in room history, while the
current report route requires every author label to resolve to a member. It
rejects that report before storing evidence. Its NOT NULL target and INNER JOIN
reads also prevent representing and reviewing authorless-account evidence.

A message is evidence of content and an author label, not proof that a current
account exists. Fabricating an account or deleting history is not an acceptable
repair. Public identity remains a real browser key, with no legacy fallback.

## Decision

Reports retain the authoritative message author label alongside the existing body
snapshot. Their reported member link becomes optional, with a real FK when set
and ON DELETE SET NULL on target removal. A database CHECK requires a linked
member or a nonblank retained label. New report/automatic-flag writes always
include their authoritative author label; historical labels are backfilled only
where known.

Queue/detail reads use LEFT JOIN and prefer retained author evidence. The wire
contract separates display handle from a current linked suspendHandle. Deletion
and dismissal work from the stored report without an account. Suspension from a
report requires a current linked member, validated server-side against that report.
The CLI offers only actions the report can support. All current moderator role
checks and Durable Object enforcement-before-audit ordering remain.

The student endpoint preserves device auth, budgets, self-report refusal and
server-authoritative snapshots, but does not refuse retained content because its
author account is missing or deleted. Boundary JSON must be an object. The client
shows approved safe failure messages and preserves retry state.

## Consequences

- Retained legacy content can be reported, reviewed and removed without inventing
  an identity or losing evidence after account removal or message expiry.
- An unavailable author cannot be suspended; that limitation is explicit in the
  API/CLI rather than hidden behind a label that looks actionable.
- The atomic policy-flag statement gains the author snapshot without changing
  retry, dedupe, suspension/audit atomicity or acknowledgement semantics.
- One additive incremental migration must be applied before merge because merged
  main auto-deploys. Production migration remains an authorized deployment action.
- Rolling back to old readers may hide memberless reports; a forward code repair
  is safer than reverting nullable schema or deleting records.

## Alternatives

A clearer error alone leaves visible content unreportable. Synthetic accounts
violate identity integrity. Deleting old content destroys evidence. A separate
legacy report store duplicates moderation. One evidence record with an optional
real account link directly represents the available facts.
