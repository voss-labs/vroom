# VRIP-13: Anonymous by device key, superseding VRIP-04

**Status:** Accepted
**Date:** 2026-10-06
**Author:** Harshal More
**Supersedes:** VRIP-04

## Context

VRIP-04 made V Rooms pseudonymous rather than anonymous: students see a handle,
VOSS keeps a readable mapping from that handle to a V Auth account, and a
moderator can resolve it from a report. It considered the vask model and
rejected it because it cannot coexist with verified college membership.

The question has been reopened. Students should be able to use V Rooms the way
they use vask, where VOSS genuinely cannot tell who anyone is. vask gets that
from an SSH key the student generates and holds: the server stores
`sha256(public key)` and never learns a name or an email. V Rooms is a web app,
so the equivalent has to come from the browser.

Browser fingerprinting was raised as the mechanism and is rejected below. A
fingerprint is a guess at a device, not a credential the student holds. The
honest browser equivalent of a vask key is a key pair the browser generates
once and keeps.

## Decision

Students enter V Rooms with a device key, not V Auth.

- On first visit the browser generates an ECDSA P-256 key pair with WebCrypto,
  marks the private key non-extractable, and stores it in IndexedDB. The
  private key never leaves the browser and cannot be read by script.
- The server identifies a student by `sha256(SPKI public key)` and stores
  nothing else about them: no email, no name, no V Auth subject, no IP address.
- To enter, the browser signs a short-lived server challenge. The server
  verifies the signature against the public key, resolves the hash to a member,
  and sets a session cookie carrying only the member id. Minting the app token
  then works as VRIP-07 describes. The token, the socket and the Durable Object
  do not change.
- Handles are still auto-assigned on first use and stable for that key.
- Moderators keep signing in with V Auth. The console still needs a person who
  can be held accountable, and VRIP-05's server-side role check stays as it is.
  Only the student path changes.

There is no identity mapping, so there is nothing to reveal. The `reveal`
action, `identity.server.ts` and the reveal dialog are removed.

## Consequences

- Win: anonymity becomes a claim the code can back up. VOSS cannot be compelled
  to disclose what it never held, and a database breach yields handles and
  hashes, not people.
- Win: no sign-in step at all, which removes the largest drop-off point in front
  of a cold-start product.
- Win: the socket trust boundary is unchanged. VRIP-07's token, subprotocol and
  close codes carry over as they are.
- Cost: membership is no longer verified. Anyone on the internet can join, not
  only VIT students. `PRODUCT.md` frames the whole v1 experiment as "pseudonymous
  but everyone present is a verified member", so the hypothesis being tested
  changes, and the success metrics have to be reread against it.
- Cost: suspension stops being a real remedy. A suspended student clears site
  data or opens another browser and returns with a new handle in seconds. The
  same applies to the per-pseudonym rate limit: a determined user simply holds
  more keys. Moderation shifts from removing people to removing messages and
  closing rooms.
- Cost: there is no escalation path. VRIP-04 kept the mapping so an incident
  could end in a named referral to the administration. That option is gone.
- Cost: a handle lives on one browser. Clearing site data, switching phones or
  using a private window loses it, and there is no recovery, the same as losing
  a vask SSH key.
- Risk: institutional. `PRODUCT.md` names one harassment incident traceable to a
  VOSS-run anonymous app as a threat to the society recognition proposal. An
  unverified, unattributable room raises that risk rather than lowering it, and
  the administration should hear about this change before it ships, not after.
- Risk: prior art. Campus anonymous apps have produced targeted harassment of
  named students and staff even with email verification. Without verification
  the content policy (VRIP-09) and the kill switch carry the whole load.
- Precludes: per-person enforcement of any kind, and any later reveal. This
  cannot be undone for messages written under it, which is the point.

## Alternatives considered

- Browser fingerprinting (canvas, fonts, screen, user agent): rejected. On a
  campus where hundreds of students carry the same phone and browser, fingerprints
  collide and two students would share one handle. They also change on a browser
  update and reset in a private window, so identity is both unstable and free to
  discard. Safari, Firefox and Brave actively defeat it. And fingerprinting is a
  tracking technique, which contradicts the anonymity this change is for.
- Keep VRIP-04: the safe choice for moderation and for the administration, and
  the reason it was accepted. Rejected here only because the goal is now
  anonymity from VOSS itself, which VRIP-04 rules out by design.
- Verify once with V Auth, then issue an unlinkable credential (blind
  signatures, Privacy Pass style): keeps VIT-only membership while severing the
  mapping, and bounds how many handles one student can hold. Rejected for now as
  the most work of any option. It is the natural upgrade path if open membership
  proves to be the problem, and it reuses the device key as the holder.

## Implementation notes

- Schema: `members.user_id` is nullable and `members.key_hash` is a new unique
  column holding the hex sha256 of the SPKI public key. A student row has a key
  hash and no user id; a moderator row has a user id. Migration 0003 adds the
  CHECK `members_one_identity`, so a row carrying both, which would be the
  mapping this XIP removes, is rejected by the database.
- Sign-in is two endpoints. `POST /api/device/challenge` returns a stateless
  challenge, an HS256 JWT valid for sixty seconds. `POST /api/device/session`
  takes the public key, the challenge and a signature over a domain-separated
  string, verifies all three before any database work, and sets an HttpOnly,
  SameSite=Lax cookie holding only the member id for thirty days. Both are
  signed under `DEVICE_SESSION_SECRET`, separate from `APP_JWT_SECRET`.
- Refined during build: VRIP-13 first proposed a signature on every token mint
  and report. A cookie issued once from a verified proof gives the same
  guarantee with one code path. `resolveActor` in `require-role.server.ts`
  resolves either a moderator's better-auth session or a student's device
  cookie, and the room loader, the token mint and the report endpoint all use
  it.
- `requireModerator` refuses a device session, and `assertModerator` refuses a
  member with no user id, so a handle with nothing behind it never reaches the
  console or the script door, even if `is_moderator` is set on it by mistake.
- Existing student rows carry a V Auth mapping that this XIP says should not
  exist. VRIP-04 warned that reversing it does not un-retain what was collected.
  Before this ships to the production database, the author has to choose
  between retiring those handles and deleting the linked better-auth `user`
  rows, or a one-time transfer where a signed-in student binds their handle to
  a device key and the link is then deleted. Migration 0003 does neither: it
  leaves V Auth rows valid, because moderators are V Auth rows too.
- Abuse brakes that do not identify anyone. Built (2026-10-06): a Workers
  rate-limit binding on `POST /api/device/session`, keyed by connecting IP,
  counted at the edge and never written to Neon or the Durable Object. It
  charges only a key with no member row, 20 a minute per address. Deferred,
  not built: Cloudflare Turnstile on the same route, so a new handle costs a
  human a few seconds rather than costing a script nothing. Until then, a
  script can still mint 20 handles a minute from each address it controls,
  and that has to be fixed before an open launch.
- The app must not store IP addresses, and Workers observability must not
  record `cf-connecting-ip`. Cloudflare still sees the address in transit; the
  product copy must say what the code does and no more.
- The home page copy VRIP-04 required ("VOSS can see who you are") is replaced
  with an accurate statement: VOSS cannot see who you are, and losing this
  browser's data means losing your handle.
- `PRODUCT.md` needs a revision 3 covering the identity model, the target user
  and the success metrics. That goes through the preset process, not a hand
  edit.
- `AGENTS.md` hard constraints that name the mapping or reveal (the users-table
  mapping rule and the reveal CHECK) need rewording in the same change.

## Public identity correction (2026-10-19)

The original shared resolver preferred a V Auth session over a device cookie.
That let two browsers with the same V Auth session become one public actor, and
a V Auth-only browser bypass device-key creation. Public student routes now
resolve device sessions only; missing or invalid device cookies never fall back
to V Auth. This corrects the implementation to the anonymity model above.

VRIP-16 removes the browser moderation console. Accountable moderator rows and
script authorization remain. `/api/operator/sign-in` reuses the configured OAuth
flow solely to establish a real local V Auth app user and return its app ID.
Out-of-band promotion explicitly provisions the separate member and handle; it
never attaches a student's device key to an auth account.

- The persistent identity boundary is one browser profile on this origin, not
  a physical device or a person. Tabs and reloads share an IndexedDB key. An
  expired or deleted session cookie is renewed by signing a fresh challenge
  with the retained key. The existing cookie lasts thirty days and is HttpOnly,
  SameSite=Lax and Secure on HTTPS; no session bearer is written to web storage.
- First key creation generates a candidate before opening a readwrite
  transaction. That transaction re-reads the identity and keeps an existing key
  or inserts the candidate, settling only on commit. Concurrent tabs receive the
  same retained winner. Storage failures abort entry without a default identity.
