/**
 * VRIP-09's content detector. One pure module, imported by the browser composer
 * and by the Durable Object, so the two can never disagree about what a message
 * says. No runtime dependencies, exactly like `protocol.ts`.
 *
 * Normalise first, always; find targets; find terms; score a term by whether a
 * target sits within a few WORDS of it. An unnormalised comparison is the bug
 * this file exists to prevent, so every comparison — including the ones against
 * the wordlists themselves — runs through `normaliseWord`.
 */

import { ADJECTIVE_SET, ANIMAL_SET } from "./handles";
import {
  CLASS_WORD,
  DIVISION,
  FULL_NAME,
  HONORIFIC_NAME,
  NAME_HONORIFIC,
  PERSONAL,
  STAFF_ROLE,
} from "./policy-patterns";
import {
  elide,
  normalise,
  normaliseWord,
  tokenize,
  type Token,
} from "./policy-normalise";
import {
  GUARDS,
  HONORIFICS,
  TERMS,
  TRAILING_HONORIFICS,
  type Category,
} from "./policy-words";

/** Re-exported so the detector stays the one import surface for policy. */
export { redactPersonal } from "./policy-patterns";
export { normalise, normaliseWord } from "./policy-normalise";

export type Tier = "none" | "count" | "confirm" | "block";

/** Named, so no branch anywhere carries a bare tier string (VRIP-09). */
export const TIER = {
  NONE: "none",
  COUNT: "count",
  CONFIRM: "confirm",
  BLOCK: "block",
} as const satisfies Record<string, Tier>;

const RANK: Record<Tier, number> = { none: 0, count: 1, confirm: 2, block: 3 };

/** Measured in words, not characters (VRIP-09). */
export const PROXIMITY_WINDOW_WORDS = 6;

/** What a category scores on its own, before any target is considered. */
const SEVERITY: Record<Category, Tier> = {
  profanity: "block",
  sexual: "block",
  slur: "block",
  accusation: "none",
  threat: "block",
  selfharm: "block",
};

const CATEGORY_LABEL: Record<Category, string> = {
  profanity: "abuse",
  sexual: "sexual content",
  slur: "a slur",
  accusation: "an accusation",
  threat: "a threat",
  selfharm: "encouraging self-harm",
};

export interface Detection {
  tier: Tier;
  /** Human-readable, for the confirm dialog and the moderator's flag. */
  matches: string[];
  /**
   * Which kinds of personal data are in the message, labels only and never a
   * value. Non-empty is what makes a confirm-tier message ephemeral (VRIP-10).
   */
  personal: string[];
  /** Whether the message names anybody at all. */
  targeted: boolean;
  /** Offset of the first contributing match, in characters. Anchors the snippet. */
  at: number;
}

/**
 * True when the message must be broadcast and never stored: personal data is
 * present and nothing outranks it. Block outranks it — a refused message is not
 * delivered at all, so there is nothing to make ephemeral.
 */
export function isEphemeral(found: Detection): boolean {
  return found.tier === TIER.CONFIRM && found.personal.length > 0;
}

interface Span {
  first: number;
  last: number;
}

/* ---------------- indexes, built once ---------------- */

type Term = { parts: string[]; category: Category };

/**
 * Normalisation cannot restore a letter that was never typed, so each term is
 * also indexed under its elided skeleton.
 *
 * A skeleton is only registered when the word is at least MIN_ELIDE_SOURCE long
 * and the skeleton at least MIN_ELIDE_LENGTH — shorter ones collide with
 * ordinary words and the false positives are not worth the catch.
 */
const MIN_ELIDE_SOURCE = 4;
const MIN_ELIDE_LENGTH = 3;

/** Phrases are never elided: `beat you` would index as `bt y`, which is `but y` (VRIP-14). */
const UNELIDED: ReadonlySet<Category> = new Set(["threat", "selfharm"]);

const TERM_INDEX = new Map<string, Term[]>();
function indexTerm(parts: string[], category: Category): void {
  const bucket = TERM_INDEX.get(parts[0]) ?? [];
  bucket.push({ parts, category });
  TERM_INDEX.set(parts[0], bucket);
}
for (const [category, words] of Object.entries(TERMS)) {
  for (const word of words) {
    const parts = normalise(word).split(" ").filter(Boolean);
    if (!parts.length) continue;
    indexTerm(parts, category as Category);

    const skeleton = parts.map(elide);
    const changed = skeleton.some((part, i) => part !== parts[i]);
    const viable = parts.every(
      (part, i) =>
        part.length < MIN_ELIDE_SOURCE ||
        skeleton[i].length >= MIN_ELIDE_LENGTH,
    );
    if (changed && viable && !UNELIDED.has(category as Category)) {
      indexTerm(skeleton, category as Category);
    }
  }
}

const GUARD_INDEX = new Map<string, Set<string>>(
  Object.entries(GUARDS).map(([term, words]) => [
    normalise(term),
    new Set(words.map((w) => normalise(w))),
  ]),
);

const HANDLE_ADJECTIVES = new Set([...ADJECTIVE_SET].map(normaliseWord));
const HANDLE_ANIMALS = new Set([...ANIMAL_SET].map(normaliseWord));

/* ---------------- scanning ---------------- */

function spanOf(tokens: Token[], start: number, end: number): Span | null {
  let first = -1;
  let last = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].end > start && tokens[i].start < end) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return first < 0 ? null : { first, last };
}

/** Words between two spans. -1 when they share words, which is not proximity. */
function wordGap(a: Span, b: Span): number {
  if (a.last < b.first) return b.first - a.last;
  if (b.last < a.first) return a.first - b.last;
  return -1;
}

interface Hit extends Span {
  label: string;
  at: number;
  /** Present on wordlist hits only; targets have no severity of their own. */
  category?: Category;
}

/** A masked word is also looked up by its skeleton (VRIP-14). */
function candidates(token: Token): Term[] {
  const direct = TERM_INDEX.get(token.norm) ?? [];
  if (!token.skeleton || token.skeleton === token.norm) return direct;
  return [...direct, ...(TERM_INDEX.get(token.skeleton) ?? [])];
}

function matchesPart(token: Token, part: string): boolean {
  return token.norm === part || token.skeleton === part;
}

function findTerms(tokens: Token[]): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i < tokens.length; i++) {
    for (const term of candidates(tokens[i])) {
      const last = i + term.parts.length - 1;
      if (last >= tokens.length) continue;
      if (term.parts.some((p, k) => !matchesPart(tokens[i + k], p))) continue;
      if (isGuarded(tokens, term.parts.join(" "), i, last)) continue;
      hits.push({
        label: CATEGORY_LABEL[term.category],
        category: term.category,
        first: i,
        last,
        at: tokens[i].start,
      });
    }
  }
  return hits;
}

/** `MC` really is the compere at every campus fest. One list, checked in words. */
function isGuarded(
  tokens: Token[],
  key: string,
  a: number,
  b: number,
): boolean {
  const guards = GUARD_INDEX.get(key);
  if (!guards) return false;
  const from = Math.max(0, a - PROXIMITY_WINDOW_WORDS);
  const to = Math.min(tokens.length - 1, b + PROXIMITY_WINDOW_WORDS);
  for (let i = from; i <= to; i++) {
    if ((i < a || i > b) && guards.has(tokens[i].norm)) return true;
  }
  return false;
}

function matchSpans(
  text: string,
  tokens: Token[],
  re: RegExp,
  label: string,
  accept?: (m: RegExpExecArray) => boolean,
): Hit[] {
  const hits: Hit[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (accept && !accept(m)) {
      // A rejected match must not consume the text it covered: `bc Prof
      // Kulkarni` matches the honorific pattern as `bc Prof` first, and
      // advancing past that would hide the honorific behind it.
      re.lastIndex = m.index + 1;
      continue;
    }
    const span = spanOf(tokens, m.index, m.index + m[0].length);
    if (span) hits.push({ ...span, label, at: m.index });
  }
  return hits;
}

function findPersonal(text: string, tokens: Token[]): Hit[] {
  const hits: Hit[] = [];
  for (const { label, re } of PERSONAL) {
    for (const hit of matchSpans(text, tokens, re, label)) {
      // An email's domain also reads as an Instagram handle. One label is enough.
      if (hits.some((seen) => wordGap(seen, hit) === -1)) continue;
      hits.push(hit);
    }
  }
  return hits;
}

const NAMED = "an honorific and a name";
const DIVISION_LABEL = "a class or division";

function bare(word: string): string {
  return word.toLowerCase().replace(/[^a-z]/g, "");
}

/** Handles are `adjective-animal`, so two adjacent tokens from the two lists. */
function findHandles(tokens: Token[]): Hit[] {
  const hits: Hit[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const pair =
      HANDLE_ADJECTIVES.has(tokens[i].norm) &&
      HANDLE_ANIMALS.has(tokens[i + 1].norm);
    if (pair) {
      hits.push({
        label: "a handle",
        first: i,
        last: i + 1,
        at: tokens[i].start,
      });
    }
  }
  return hits;
}

function findTargets(text: string, tokens: Token[]): Hit[] {
  const at = (
    re: RegExp,
    label: string,
    ok?: (m: RegExpExecArray) => boolean,
  ) => matchSpans(text, tokens, re, label, ok);
  return [
    ...findHandles(tokens),
    ...at(HONORIFIC_NAME, NAMED, (m) => HONORIFICS.has(bare(m[1]))),
    ...at(NAME_HONORIFIC, NAMED, (m) => TRAILING_HONORIFICS.has(bare(m[2]))),
    ...at(FULL_NAME, "a named person"),
    ...at(DIVISION, DIVISION_LABEL),
    ...at(CLASS_WORD, DIVISION_LABEL),
    ...at(STAFF_ROLE, "a member of staff"),
  ];
}

/* ---------------- the detector ---------------- */

/**
 * Score a message. A term alone scores its category's severity; a term with a
 * target within PROXIMITY_WINDOW_WORDS blocks, which is what turns counted
 * banter into an incident and what catches a named professor plus an accusation
 * with no profanity in it at all.
 */
export function detect(text: string): Detection {
  const tokens = tokenize(text);
  const targets = findTargets(text, tokens);
  const matches: string[] = [];
  let tier: Tier = TIER.NONE;
  let at = -1;

  const add = (next: Tier, label: string, offset: number) => {
    if (RANK[next] <= RANK.none) return;
    if (!matches.includes(label)) matches.push(label);
    if (RANK[next] > RANK[tier]) tier = next;
    if (at < 0 || offset < at) at = offset;
  };

  for (const hit of findTerms(tokens)) {
    const near = targets.find((t) => {
      const gap = wordGap(hit, t);
      return gap > 0 && gap <= PROXIMITY_WINDOW_WORDS;
    });
    add(near ? TIER.BLOCK : SEVERITY[hit.category!], hit.label, hit.at);
    if (near) add(TIER.BLOCK, near.label, hit.at);
  }

  // Personal data never escalates. A phone number beside a name is still a
  // phone number, and blocking it would spend the interruption budget on the
  // exact case the confirm dialog exists for.
  const personal: string[] = [];
  for (const hit of findPersonal(text, tokens)) {
    if (!personal.includes(hit.label)) personal.push(hit.label);
    add(TIER.CONFIRM, hit.label, hit.at);
  }
  for (const hit of targets.filter((h) => h.label === NAMED)) {
    add(TIER.CONFIRM, hit.label, hit.at);
  }

  return {
    tier,
    matches,
    personal,
    targeted: targets.length > 0,
    at: Math.max(at, 0),
  };
}
