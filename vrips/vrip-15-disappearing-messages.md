# VRIP-15: 48-hour disappearing window for all stored messages

**Status:** Accepted
**Date:** 2026-10-18
**Author:** Harshal More
**Amends:** VRIP-03, VRIP-10, VRIP-11

## Context

`PRODUCT.md` originally fixed message retention as full history, kept and
scrollable forever. Under VRIP-10 personal-data messages were exempted (never
written to the store and removed from the screen after sixty seconds), while
ordinary messages accumulated indefinitely in each room's Durable Object SQLite.

Permanent chat history fights the social premise of V Rooms. A campus live room
is meant to be a lightweight, present-tense conversation — what is happening in
the mess today, who is in the lab right now, which company is visiting this week.
When every casual remark sits in scrollback for months, the room feels like a
permanent archive rather than a live space, and the database steadily accumulates
context that nobody needs two days later.

## Decision

Every stored message in V Rooms has a 48-hour lifetime (`MESSAGE_TTL_MS = 48 * 60 * 60 * 1000`).

- Messages older than 48 hours are **hard-deleted** from the room's `messages`
  table in Durable Object SQLite (`DELETE FROM messages WHERE created_at <= ?`).
- Pruning runs inside the Durable Object on room activity (`onJoin`, `handleSend`,
  `handleHistory`, `stats`, `countsByPseudonym`) and via a Durable Object
  `alarm()` scheduled at the next message's expiry timestamp, so a quiet room
  still empties its expired rows on time without waiting for a visitor.
- Every read path (`recentMessages`, `messagesBefore`, `findMessage`,
  `messageStats`, `countsByPseudonym`) also enforces the `created_at > now - MESSAGE_TTL_MS`
  window so an unpruned row between ticks is never served, counted, or snapshotted.
- Connected clients run a lightweight sweep that removes any stored message from
  the live view once its 48-hour window elapses, and the UI states clearly that
  messages disappear after 48 hours and are deleted from the database.

VRIP-10's 60-second ephemeral path for personal data is unchanged: phone numbers,
emails, and social handles are still never written to the store at all.

## The moderation and evidence question

VRIP-11 rejected author-initiated hard deletes so an author could not erase a
message seconds after sending it before anyone could report it. A 48-hour
system-wide expiry is different:

- Within the 48-hour window, author withdrawal and moderator deletion still
  soft-delete the row (`deleted_at`, `deleted_by`), keeping the text readable to
  the report endpoint until the 48-hour window closes.
- When a student reports a message, `POST /api/report` snapshots the message
  text into Neon's `reports` table at the time of the report. That snapshot and
  the moderation `audit` log live in Neon and survive after the room's 48-hour
  SQLite row is deleted.
- Auto-flagged blocked messages (VRIP-09, VRIP-14) live in the `flags` table and
  drain to Neon reports independently of `messages`.

## Consequences

- Win: the room matches how students actually use campus chat — live conversation
  with enough scrollback to catch up on yesterday and today, without a permanent
  record hanging over casual speech.
- Win: Durable Object SQLite storage stays bounded automatically across all five
  rooms without manual maintenance.
- Cost: a message that nobody reported within 48 hours is gone permanently and
  cannot be reported or read afterwards.
- Precludes: full-semester scrollback or historical archives inside the room.

## Implementation notes

- `MESSAGE_TTL_MS = 48 * 60 * 60 * 1000` (172,800,000 ms) lives in
  `workers/protocol.ts` alongside `EPHEMERAL_TTL_MS` so the Durable Object and
  the browser share one constant.
- `idx_messages_created_at` indexes `messages(created_at)` so `pruneExpiredMessages`
  is a range delete rather than a full table scan.
- `RoomDurableObject.alarm()` prunes expired rows and schedules the next alarm
  at `oldestCreatedAt + MESSAGE_TTL_MS` whenever rows remain in `messages`.
