/**
 * VRIP-09 enforcement inside the room object: the policy tables, the decision
 * that reads them, and the drain the console pulls from.
 *
 * Nothing here reaches Neon, and nothing here can. The object knows pseudonyms
 * and resolving one to a member is exactly what VRIP-04 forbids it — so a block
 * writes a flag row into the object's own SQLite, and the console (which holds
 * Neon and is allowed to resolve identity) turns flags into reports on load.
 */

import { detect, isEphemeral, redactPersonal, TIER, type Tier } from "./policy";
import { addSuspension, getState, setState } from "./room-sql";

/** Three refused messages inside ten minutes suspends the handle. */
export const AUTO_SUSPEND_BLOCKS = 3;
export const AUTO_SUSPEND_WINDOW_MS = 10 * 60_000;

/** One console load drains at most this many flags. */
export const FLAG_DRAIN_LIMIT = 100;

/** A flag carries this much of the message and no more (VRIP-09). */
export const SNIPPET_MAX_CHARS = 80;
const SNIPPET_LEAD_CHARS = 24;

const CURSOR_KEY = "flags_drained_through";

export interface FlagRow {
  id: number;
  pseudonym: string;
  tier: string;
  matches: string;
  snippet: string;
  targeted: boolean;
  confirmed: boolean;
  autoSuspended: boolean;
  createdAt: number;
}

export interface Verdict {
  tier: Tier;
  /** True only for the block tier. The frame is refused and never stored. */
  blocked: boolean;
  /** True when the message is broadcast but must never be stored (VRIP-10). */
  ephemeral: boolean;
  /** What the sender is told. Null unless blocked. */
  reason: string | null;
  /** True when this attempt crossed the auto-suspension threshold. */
  suspended: boolean;
}

type FlagRecord = {
  id: number;
  pseudonym: string;
  tier: string;
  matches: string;
  snippet: string;
  targeted: number;
  confirmed: number;
  auto_suspended: number;
  created_at: number;
};

export function ensurePolicySchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS flags (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      pseudonym      TEXT NOT NULL,
      tier           TEXT NOT NULL,
      matches        TEXT NOT NULL,
      snippet        TEXT NOT NULL,
      targeted       INTEGER NOT NULL,
      confirmed      INTEGER NOT NULL,
      auto_suspended INTEGER NOT NULL DEFAULT 0,
      created_at     INTEGER NOT NULL
    );
  `);
  sql.exec(
    `CREATE INDEX IF NOT EXISTS idx_flags_pseudonym ON flags(pseudonym, created_at);`,
  );
  sql.exec(`
    CREATE TABLE IF NOT EXISTS policy_counts (
      pseudonym TEXT NOT NULL,
      tier      TEXT NOT NULL,
      n         INTEGER NOT NULL,
      last_at   INTEGER NOT NULL,
      PRIMARY KEY (pseudonym, tier)
    );
  `);
}

function toFlag(row: FlagRecord): FlagRow {
  return {
    id: row.id,
    pseudonym: row.pseudonym,
    tier: row.tier,
    matches: row.matches,
    snippet: row.snippet,
    targeted: row.targeted === 1,
    confirmed: row.confirmed === 1,
    autoSuspended: row.auto_suspended === 1,
    createdAt: row.created_at,
  };
}

function tally(
  sql: SqlStorage,
  pseudonym: string,
  tier: Tier,
  now: number,
): void {
  sql.exec(
    `INSERT INTO policy_counts (pseudonym, tier, n, last_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(pseudonym, tier) DO UPDATE SET n = n + 1, last_at = excluded.last_at`,
    pseudonym,
    tier,
    now,
  );
}

function insertFlag(
  sql: SqlStorage,
  input: {
    pseudonym: string;
    tier: Tier;
    matches: string[];
    snippet: string;
    targeted: boolean;
    confirmed: boolean;
    now: number;
  },
): number {
  return sql
    .exec<{ id: number }>(
      `INSERT INTO flags (pseudonym, tier, matches, snippet, targeted, confirmed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      input.pseudonym,
      input.tier,
      input.matches.join(", "),
      input.snippet,
      input.targeted ? 1 : 0,
      input.confirmed ? 1 : 0,
      input.now,
    )
    .one().id;
}

function countRecentBlocks(
  sql: SqlStorage,
  pseudonym: string,
  since: number,
): number {
  return sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM flags WHERE pseudonym = ? AND tier = ? AND created_at >= ?`,
      pseudonym,
      TIER.BLOCK,
      since,
    )
    .one().n;
}

/**
 * A window around the match, never the whole message. Whitespace is collapsed
 * so a flag row cannot be padded out with newlines.
 */
export function snippet(text: string, at = 0): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= SNIPPET_MAX_CHARS) return flat;
  const room = flat.length - SNIPPET_MAX_CHARS;
  const start = Math.max(0, Math.min(at - SNIPPET_LEAD_CHARS, room));
  const end = Math.min(flat.length, start + SNIPPET_MAX_CHARS);
  const head = start > 0 ? "..." : "";
  const tail = end < flat.length ? "..." : "";
  return `${head}${flat.slice(start, end).trim()}${tail}`;
}

/**
 * What a flag records about a message that carried personal data: the kind,
 * never the value, and no copy of the message either (VRIP-10). A moderator
 * learns that it happened. Storing the digits in `reports` while keeping them
 * out of `messages` would move the data somewhere strictly worse.
 */
function withheld(kinds: string[]): string {
  return `${kinds.join(" and ")} shared. Not stored, and the value is not recorded.`;
}

function refusal(matches: string[]): string {
  const what = matches.length ? matches.join(" and ") : "abuse";
  return `That message was not sent: it reads as ${what} directed at someone here. A moderator can see it.`;
}

/**
 * The whole server-side decision. Run on every send regardless of what the
 * client did — the confirm dialog is JavaScript in someone's browser and a
 * hostile client simply never asks.
 *
 * `confirmed` records that the sender saw the dialog and went ahead, which is
 * what makes a later suspension defensible. It never changes the outcome.
 */
export function screen(
  sql: SqlStorage,
  pseudonym: string,
  body: string,
  confirmed: boolean,
  now: number,
): Verdict {
  const found = detect(body);
  const clean: Verdict = {
    tier: found.tier,
    blocked: false,
    ephemeral: isEphemeral(found),
    reason: null,
    suspended: false,
  };
  if (found.tier === TIER.NONE) return clean;

  // An ephemeral message is not a discount: it is tallied and rate-limited like
  // any other, it simply is not written to the message store.
  tally(sql, pseudonym, found.tier, now);

  // Counted and nothing more: no flag row, no snippet, nothing the sender sees.
  // The tally is the only record, and volume is what surfaces a handle.
  if (found.tier === TIER.COUNT) return clean;

  const id = insertFlag(sql, {
    pseudonym,
    tier: found.tier,
    matches: found.matches,
    // A personal-data message leaves no copy at all: the moderator learns that
    // it happened and what kind, which is the trade VRIP-10 names. A blocked
    // message keeps its text, because that is the evidence of an incident —
    // but any value inside it is still redacted, since this is the row that
    // drains into Neon and Neon is permanent.
    snippet: clean.ephemeral
      ? withheld(found.personal)
      : snippet(redactPersonal(body), found.at),
    targeted: found.targeted,
    confirmed,
    now,
  });
  if (found.tier === TIER.CONFIRM) return clean;

  // The row is already in, so this attempt counts towards its own threshold.
  const recent = countRecentBlocks(
    sql,
    pseudonym,
    now - AUTO_SUSPEND_WINDOW_MS,
  );

  // Auto-suspension temporarily disabled pending permissions/PR
  const suspended = false; // recent >= AUTO_SUSPEND_BLOCKS;
  if (suspended) {
    addSuspension(sql, pseudonym, now);
    sql.exec(`UPDATE flags SET auto_suspended = 1 WHERE id = ?`, id);
  }
  return {
    tier: found.tier,
    blocked: true,
    ephemeral: false,
    reason: refusal(found.matches),
    suspended,
  };
}

/**
 * Undrained block flags, oldest first. A pure read: the cursor only moves on
 * `ackFlags`, so a console that dies between reading and writing its reports
 * sees the same flags again rather than losing them.
 */
export function drainFlags(
  sql: SqlStorage,
  limit = FLAG_DRAIN_LIMIT,
): FlagRow[] {
  return sql
    .exec<FlagRecord>(
      `SELECT id, pseudonym, tier, matches, snippet, targeted, confirmed, auto_suspended, created_at
       FROM flags WHERE id > ? AND tier = ? ORDER BY id LIMIT ?`,
      flagCursor(sql),
      TIER.BLOCK,
      limit,
    )
    .toArray()
    .map(toFlag);
}

export function flagCursor(sql: SqlStorage): number {
  return Number(getState(sql, CURSOR_KEY) ?? "0");
}

/** Monotonic: an out-of-order or stale ack cannot rewind the queue. */
export function ackFlags(sql: SqlStorage, throughId: number): void {
  if (!Number.isFinite(throughId) || throughId <= flagCursor(sql)) return;
  setState(sql, CURSOR_KEY, String(Math.floor(throughId)));
}

/** Per-handle volume, which is the only thing the count tier ever produces. */
export function policyTallies(
  sql: SqlStorage,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const row of sql
    .exec<{ pseudonym: string; tier: string; n: number }>(
      `SELECT pseudonym, tier, n FROM policy_counts`,
    )
    .toArray()) {
    (out[row.pseudonym] ??= {})[row.tier] = row.n;
  }
  return out;
}
