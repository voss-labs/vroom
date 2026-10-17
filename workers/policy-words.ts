/**
 * VRIP-09's vocabulary. Data only — no logic, no regexes over message text.
 *
 * This file is expected to grow; the detector is not. Every entry here is
 * normalised by `policy.ts` at module load, so entries may be written in their
 * natural spelling (including Devanagari) and still compare equal to whatever a
 * student types. Adding a Latin transliteration AND the Devanagari spelling is
 * correct and not redundant: the transliterator is deterministic, not faithful,
 * so `मादरचोद` and `madarchod` do not fold to the same string.
 *
 * Severity lives in `SEVERITY`, keyed by category, never on the word. That is
 * what lets a word move between lists without any branch changing, and it is
 * what makes "a count word next to a target becomes block" one rule rather than
 * one rule per word.
 */

export type Category =
  "profanity" | "slur" | "sexual" | "accusation" | "threat" | "selfharm";

export const TERMS: Record<Category, readonly string[]> = {
  /**
   * The normal register of the room. Alone this is counted and nothing else —
   * blocking it would make V Rooms feel like a school intranet, which is the
   * one thing it cannot afford (VRIP-09).
   */
  profanity: [
    "bc",
    "bkl",
    "bsdk",
    "bhosdk",
    "bhosdike",
    "bhosadike",
    "bhosda",
    "bhosdi",
    "bhosadi",
    "mkc",
    "mkb",
    "mc",
    "madarchod",
    "madarchood",
    "madrchod",
    "madarjaat",
    "behenchod",
    "bhenchod",
    "bhainchod",
    "benchod",
    "bahenchod",
    "chutiya",
    "chutiye",
    "chutya",
    "chodu",
    "chutmarike",
    "gandu",
    "gaandu",
    "gand",
    "gaand",
    "gandfat",
    "lund",
    "lawda",
    "lauda",
    "laudya",
    "lavdu",
    "lodu",
    "jhatu",
    "pagal",
    "tu pagal",
    "randi",
    "harami",
    "haramkhor",
    "kutiya",
    "jhaant",
    "jhant",
    "tatti",
    "chinaal",
    "bhadwa",
    "bhadve",
    "saala",
    "zavadya",
    "jhavadya",
    "aaicha ghoo",
    "bhikarchot",
    "fuck",
    // Two masked letters leave a skeleton too short to index (VRIP-14).
    "f**k",
    "f**king",
    "fucking",
    "fucker",
    "motherfucker",
    "bitch",
    "bastard",
    "asshole",
    "dickhead",
    "cunt",
    "मादरचोद",
    "भोसडीके",
    "चूतिया",
    "गांडू",
    "रंडी",
    "हरामी",
    "भेनचोद",
    "बहनचोद",
    "लंड",
    "झवाड्या",
  ],

  /**
   * Caste, communal and racial abuse. Blocked whether or not it names anyone,
   * because the target is the group and it is always present.
   */
  slur: [
    "chamar",
    "bhangi",
    "chuhra",
    "katua",
    "landya",
    "chinki",
    "dhed",
    "nigger",
    "faggot",
    "retard",
    "tranny",
  ],

  /** Blocked once it is aimed at somebody; counted otherwise. */
  sexual: [
    "rape",
    "raped",
    "rapist",
    "molest",
    "molested",
    "nudes",
    "nude",
    "nangi",
    "nanga",
    "horny",
    "boobs",
    "chuchi",
    "sexy",
    "randi khana",
    "chod dunga",
    "gaand mar",
  ],

  /**
   * The case with no profanity in it at all: a named person and an allegation.
   * Alone these are ordinary words and score nothing — "the exam was a scam" is
   * not an incident. Next to a named target they are the defamation that
   * actually endangers VOSS, so they block.
   */
  accusation: [
    "bribe",
    "bribes",
    "bribery",
    "ghoos",
    "harass",
    "harasses",
    "harassed",
    "harassment",
    "harasser",
    "molests",
    "corrupt",
    "corruption",
    "cheat",
    "cheats",
    "cheated",
    "cheating",
    "cheater",
    "casteist",
    "racist",
    "sexist",
    "fraud",
    "scam",
    "scammer",
    "pervert",
    "creep",
    "creepy",
    "stalker",
    "stalking",
    "predator",
    "favouritism",
    "favoritism",
    "paid him",
    "paid her",
  ],

  /**
   * Violence aimed at the reader (VRIP-14). Second-person phrases, never bare
   * verbs, so "this assignment is killing me" stays legal. Blocked alone: the
   * target is the `you` inside the phrase.
   */
  threat: [
    "kill you",
    "kill u",
    "murder you",
    "stab you",
    "stab u",
    "shoot you",
    "beat you up",
    "beat u up",
    "beat you",
    "punch you",
    "slap you",
    "break your legs",
    "break your face",
    "smash your face",
    "rape you",
    "rape u",
    "acid attack",
    "throw acid",
    "know where you live",
    "watch your back",
    "you are dead",
    "you're dead",
    "maar dunga",
    "maar dalunga",
    "maar daalunga",
    "maar denge",
    "maar dalenge",
    "jaan se maar",
    "goli maar",
    "chaku maar",
    "thok dunga",
    "haddi tod dunga",
    "taange tod dunga",
    "muh tod dunga",
    "marun takin",
    "मार दूंगा",
    "जान से मार",
    "गोली मार",
  ],

  /**
   * Telling someone to harm themselves (VRIP-14). A student writing about
   * themselves ("I want to kill myself") matches nothing here, and must not.
   */
  selfharm: [
    "kill yourself",
    "kill urself",
    "kill your self",
    "kill ur self",
    "kys",
    "go die",
    "go and die",
    "just die",
    "neck yourself",
    "hang yourself",
    "mar ja",
    "marja",
    "ja ke mar",
    "jaake mar",
    "suicide karle",
    "suicide kar le",
    "suicide kar lo",
    "phansi laga le",
    "fansi laga le",
    "मर जा",
  ],
};

/**
 * Words that, near an ambiguous term, mean it was not abuse.
 *
 * Only the short forms need this. "because" never needs a guard because it
 * tokenises as one word and never equals `bc`; "MC" genuinely does mean the
 * compere at every campus fest, and that is worth one list.
 */
export const GUARDS: Record<string, readonly string[]> = {
  mc: [
    "compere",
    "emcee",
    "anchor",
    "anchoring",
    "host",
    "hosted",
    "hosting",
    "stage",
    "fest",
    "event",
    "mic",
    "ceremony",
  ],
  // `bcc` is not listed: it normalises to `bc` itself, so it would be the term
  // rather than a guard on it.
  bc: ["email", "mail", "inbox", "forward", "forwarded", "recipient"],
  sexy: ["looks", "looked", "design", "ui", "font", "car", "bike"],
  // Bunking a lecture, not hitting anyone (VRIP-14).
  "maar dunga": [
    "lecture",
    "class",
    "bunk",
    "chakkar",
    "round",
    "gol",
    "sutta",
  ],
  // Exhaustion said about yourself: "garmi se mar ja raha hu".
  "mar ja": ["raha", "rahi", "rahe", "gaya", "gayi", "hu", "hoon", "garmi"],
};

/**
 * Matched case-insensitively against the word before a capitalised name, which
 * is the whole point of the pattern: `Prof Kulkarni` and `prof Kulkarni` name
 * the same person. Apostrophes are stripped before the lookup, so `ma'am` and
 * `maam` are one entry.
 */
export const HONORIFICS: ReadonlySet<string> = new Set([
  "dr",
  "prof",
  "professor",
  "sir",
  "madam",
  "maam",
  "mam",
  "mr",
  "mrs",
  "ms",
  "miss",
  "hod",
  "dean",
  "principal",
  "warden",
]);

/**
 * The same thing said the way it is actually said on this campus: the honorific
 * trails the name. `Kulkarni sir harasses juniors` names a person exactly as
 * precisely as `Prof Kulkarni` does, and only this list sees it.
 */
export const TRAILING_HONORIFICS: ReadonlySet<string> = new Set([
  "sir",
  "maam",
  "mam",
  "madam",
  "ji",
  "hod",
]);

/**
 * Branch codes, matched only in upper case. voss-ask's `reClassSpec` is
 * case-insensitive and therefore reads "is it a good idea" as class `IT-A`;
 * here a division reference is a target that can turn counted profanity into a
 * block, so that false positive is not affordable. Real usage is `CS-A`, `IT-B`.
 */
export const DIVISIONS: readonly string[] = [
  "CS",
  "CSE",
  "IT",
  "ISE",
  "EXTC",
  "ENTC",
  "ECE",
  "EEE",
  "ELEX",
  "MECH",
  "CIVIL",
  "CHEM",
  "AIML",
  "AIDS",
  "AI-DS",
  "BIOTECH",
  "COMPS",
  "INSTRU",
  "MBA",
  "MCA",
];
