/**
 * VRIP-09's normaliser, with VRIP-14's evasion fixes. Split out of `policy.ts`
 * so the detector reads as scoring and this file reads as folding: everything
 * a student can do to one word to stop it comparing equal ends up here.
 *
 * No runtime dependencies, like the detector, because the browser composer
 * imports both.
 */

import { CONFUSABLES, DEVANAGARI, MASKS } from "./policy-chars";

export interface Token {
  norm: string;
  /**
   * Canonical Hinglish/Marathi phonetic form (`bh`->`b`, `ph`->`f`, `w`->`v`,
   * `z`->`j`, `au`/`ow`->`av`, etc.) so spelling variations across Hindi and
   * Marathi transliterations match without inflating the wordlist.
   */
  phonetic?: string;
  /**
   * A masked word's vowel-dropped form, also compared against the wordlists.
   * `ch*tiya` is missing a letter no mapping can restore (VRIP-14).
   */
  skeleton?: string;
  start: number;
  end: number;
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
/** Zero-width characters sit inside a word rather than splitting it. */
const INVISIBLE = /\p{Cf}/u;
/** Part of a word only between two word characters: `f*ck`, never `**bold**`. */
const MASK_CHAR = /[*@$!#_%^]/;
const MASKED = /[\d*@$!#_%^]/;
const LETTER = /\p{L}/u;
const COMBINING = /\p{M}/gu;
const SINGLE_LETTER = /^[a-z]$/;
const REPEAT = /(.)\1+/g;
const NUKTA_PAIRS: ReadonlyArray<readonly [RegExp, string]> = [
  [/क़/g, "k"],
  [/ख़/g, "kh"],
  [/ग़/g, "g"],
  [/ज़/g, "z"],
  [/ड़/g, "r"],
  [/ढ़/g, "rh"],
  [/फ़/g, "f"],
];

function mapChars(raw: string, table: Record<string, string>): string {
  let pre = raw;
  for (const [re, rep] of NUKTA_PAIRS) pre = pre.replace(re, rep);
  let out = "";
  for (const ch of pre) out += table[ch] ?? ch;
  return out;
}

/**
 * Lowercase, fold compatibility forms (full-width and mathematical letters),
 * strip diacritics, read look-alike letters as Latin, collapse a repeated
 * letter to one, then fold the two digraphs that carry the Devanagari mapping:
 * `च` transliterates to `ch`, and `म क च` only reduces to `mkc` if `ch` folds to
 * `c`. The wordlists fold the same way, so both sides of every comparison meet
 * in the middle.
 */
export function normaliseWord(raw: string): string {
  const folded = mapChars(raw, DEVANAGARI)
    .normalize("NFKD")
    .replace(COMBINING, "")
    .toLowerCase();
  return mapChars(folded, CONFUSABLES)
    .replace(/[^a-z0-9]/g, "")
    .replace(REPEAT, "$1")
    .replace(/ch/g, "c")
    .replace(/jh/g, "j");
}

/**
 * Folds Hinglish and Marathi transliteration equivalences (`w`/`v`/`au` in
 * `lawda`/`lavda`/`lauda`, `z`/`j`/`zh` in `zavadya`/`jhavadya`/`javadya`,
 * `ph`/`f` in `phuddi`/`fuddi`, and aspirated consonants `bh`/`dh`/`th`/`kh`/`gh`)
 * into a single canonical key. Applied only to tokens of length >= 4 so short
 * English words and abbreviations never collide.
 */
export function phoneticWord(norm: string): string {
  if (norm.length < 4) return norm;
  return norm
    .replace(/ph/g, "f")
    .replace(/bh/g, "b")
    .replace(/dh/g, "d")
    .replace(/th/g, "t")
    .replace(/kh/g, "k")
    .replace(/gh/g, "g")
    .replace(/sh/g, "s")
    .replace(/zh/g, "j")
    .replace(/z/g, "j")
    .replace(/w/g, "v")
    .replace(/au/g, "av")
    .replace(/ow/g, "av")
    .replace(REPEAT, "$1");
}

/**
 * Dropping the vowels is the other one-keystroke evasion: `fck` for `fuck`,
 * `bhnchd` for `bhenchod`. A leading vowel is kept.
 */
export function elide(word: string): string {
  return word.slice(0, 1) + word.slice(1).replace(/[aeiou]/g, "");
}

const MAX_INSERTED_VOWELS = 2;

/**
 * True when `typed` is `term` with at most two `a`s written in (`bhosda` as
 * `bhosada`). Only `a` counts: that is the schwa Hindi and Marathi romanisation
 * adds. Inserting any other vowel would also block ordinary words (`counts`
 * for `cunts`).
 */
export function isVowelVariant(typed: string, term: string): boolean {
  if (!typed || !term || typed.length <= term.length) return false;
  if (typed.length - term.length > MAX_INSERTED_VOWELS) return false;
  let i = 0;
  let inserted = 0;
  for (const ch of typed) {
    if (i < term.length && ch === term[i]) i++;
    else if (ch === "a") inserted++;
    else return false;
  }
  return i === term.length && inserted === typed.length - term.length;
}

function isCore(ch: string | undefined): boolean {
  return ch !== undefined && (WORD_CHAR.test(ch) || INVISIBLE.test(ch));
}

function inWord(text: string, i: number, ch: string): boolean {
  if (isCore(ch)) return true;
  if (!MASK_CHAR.test(ch)) return false;
  const near = (c: string | undefined) =>
    isCore(c) || (c !== undefined && MASK_CHAR.test(c));
  return near(text[i - 1]) && near(text[i + 1]);
}

function buildToken(
  norm: string,
  masked: boolean,
  start: number,
  end: number,
): Token {
  const phon = phoneticWord(norm);
  const phonetic = phon !== norm ? phon : undefined;
  const skeleton = masked ? elide(norm) : undefined;
  return { norm, phonetic, skeleton, start, end };
}

function wordToken(raw: string, start: number, end: number): Token | null {
  const masked = LETTER.test(raw) && MASKED.test(raw);
  const norm = normaliseWord(masked ? mapChars(raw, MASKS) : raw);
  if (!norm) return null;
  return buildToken(norm, masked, start, end);
}

/**
 * Walks code points, not UTF-16 units: a mathematical letter such as `𝐟` is
 * two units, and testing either half alone reads as a separator.
 */
export function tokenize(text: string): Token[] {
  const raw: Token[] = [];
  let start = -1;
  for (let i = 0; i <= text.length;) {
    const ch =
      i < text.length ? String.fromCodePoint(text.codePointAt(i)!) : "";
    const isWord = ch !== "" && inWord(text, i, ch);
    if (isWord && start < 0) start = i;
    if (!isWord && start >= 0) {
      const token = wordToken(text.slice(start, i), start, i);
      if (token) raw.push(token);
      start = -1;
    }
    i += ch.length || 1;
  }
  return mergeInitials(raw);
}

/**
 * `m k c`, `M.K.C` and `m-k-c` are all one word once the separators go. The
 * joined word is normalised again, because `c h u t i y a` only becomes the
 * wordlist's `cutiya` once the rejoined `ch` folds (VRIP-14).
 */
function mergeInitials(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length;) {
    let j = i;
    while (j < tokens.length && SINGLE_LETTER.test(tokens[j].norm)) j++;
    if (j - i >= 2) {
      let joined = "";
      for (let k = i; k < j; k++) joined += tokens[k].norm;
      const norm = normaliseWord(joined);
      out.push(buildToken(norm, false, tokens[i].start, tokens[j - 1].end));
      i = j;
    } else {
      out.push(tokens[i]);
      i++;
    }
  }
  return out;
}

/** The normalised form of a whole message. Exported because the tests assert on it. */
export function normalise(text: string): string {
  return tokenize(text)
    .map((t) => t.norm)
    .join(" ");
}
