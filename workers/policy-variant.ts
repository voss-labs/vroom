/**
 * Vowel-insertion index for the detector. `bhosda` and `bhosada` share
 * consonants; listing every schwa a student might write does not scale.
 * Phrases and short skeletons stay out: `batch` must not become `bitch`.
 */

import { elide, normalise, phoneticWord } from "./policy-normalise";
import { TERMS, type Category } from "./policy-words";

export interface VariantTerm {
  parts: string[];
  category: Category;
}

const MIN_SOURCE = 5;
const MIN_SKELETON = 4;
const UNELIDED: ReadonlySet<Category> = new Set(["threat", "selfharm"]);

const VARIANT_INDEX = new Map<string, VariantTerm[]>();

function add(bone: string, term: VariantTerm): void {
  const bucket = VARIANT_INDEX.get(bone) ?? [];
  if (
    bucket.some(
      (t) => t.category === term.category && t.parts[0] === term.parts[0],
    )
  ) {
    return;
  }
  bucket.push(term);
  VARIANT_INDEX.set(bone, bucket);
}

function indexWord(word: string, category: Category): void {
  const bone = elide(word);
  if (word.length < MIN_SOURCE || bone.length < MIN_SKELETON || bone === word) {
    return;
  }
  add(bone, { parts: [word], category });
}

for (const [category, words] of Object.entries(TERMS)) {
  const kind = category as Category;
  if (UNELIDED.has(kind)) continue;
  for (const word of words) {
    const parts = normalise(word).split(" ").filter(Boolean);
    if (parts.length !== 1) continue;
    indexWord(parts[0], kind);
    const phon = phoneticWord(parts[0]);
    if (phon !== parts[0]) indexWord(phon, kind);
  }
}

/** Listed words whose consonants are `word`'s, for the vowel-variant check. */
export function variantTerms(word: string): VariantTerm[] {
  const bone = elide(word);
  if (bone.length < MIN_SKELETON || bone === word) return [];
  return VARIANT_INDEX.get(bone) ?? [];
}
