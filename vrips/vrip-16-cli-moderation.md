# VRIP-16: Moderate Vroom from the CLI

**Status:** Accepted
**Date:** 2026-10-19
**Author:** Harshal More
**Supersedes:** VRIP-05's browser-console requirement and VRIP-08's two-interface requirement

## Context

Vroom's browser console and script already share one moderation module. The
script can change state but cannot inspect reports, accounts, audit history or
live room state, so it cannot replace the console. Boss requested removal of
moderation from the web experience and approved building a Vauth-style CLI.

V Auth's interactive menu is the reference for the operator experience. Its
direct SQL approach does not fit Vroom: enforcement and connected sockets live
in Durable Objects while reports, members and audit live in Neon. Direct SQL
would bypass the enforcement path and server-side authorization.

## Decision

Make the CLI in the Vroom repository the moderation interface, with interactive
menus and explicit commands for report review, accounts, audit and room state,
plus the existing moderation actions. Extend the authenticated Worker API for
these reads, preserve the shared moderation module and designated moderator
bearer model, and transfer policy-flag draining to report retrieval. Remove the
browser console and its moderator entry points while retaining student report,
block and withdrawal controls.

## Consequences

- Win: one operator interface and one enforcement implementation.
- Win: moderators retain queue visibility, stored report snapshots, suspension,
  restoration, message removal, audit and the all-room kill switch.
- Win: the CLI needs no database credential and cannot bypass role checks,
  Durable Object enforcement or the shared audit path.
- Cost: moderation requires a terminal and deliberate queue checks. There is no
  new alert service in this change.
- Cost: the existing long-lived token identifies a designated moderator rather
  than each operator. VRIP-08's credential and attribution trade-offs remain.
- Risk: retiring the console without moving policy draining would strand
  automatic reports. The report-read API must drain before listing reports.
- Risk: all-room operations can partially enforce during an outage. The CLI
  must surface failure and per-room reachability, never claim atomic rollback.
- Constraint: preserve historical audit actor kinds, student anonymity, V Auth
  moderator binding, role rechecks, enforcement-before-Neon ordering and the
  retained report/audit records. No identity reveal is introduced.

## Alternatives considered

- Hide browser links and keep both interfaces: retains a browser response path,
  but keeps console code and two interfaces to maintain. Boss selected the CLI.
- Copy V Auth's direct database administration: rejected because Neon cannot
  close sockets or change Durable Object state and would bypass Vroom's controls.
- Build a full-screen terminal application or new operator-login protocol:
  deferred because menus and the existing authenticated API meet this request.

## Implementation notes

- Preserve `npm run mod -- ...` and add `npm run manage` for interactive use.
- Keep script authentication in an environment variable, never a CLI argument.
- Interactive mutations require confirmation and display the target.
- Server read operations return no student identity or moderator email.
- Report reads retain pagination and use stored snapshots after message expiry.
- Remove `/mod`, console components/styles and UI links; preserve V Auth server
  integration for moderator accounts and existing credentials.

- Moderator bootstrap is explicit: `/api/operator/sign-in` reuses configured
  Better Auth OAuth, preserves state cookies and returns only the authenticated
  local app user ID. It grants no role and honors the existing sign-in pause.
  `npm run promote -- <app-user-id>` validates a real `voss` linkage before
  creating the separate moderator member, assigning a handle and granting a role.
