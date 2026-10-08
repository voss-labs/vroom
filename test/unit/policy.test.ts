import { describe, it, expect } from "vitest";

import {
  detect,
  isEphemeral,
  normalise,
  PROXIMITY_WINDOW_WORDS,
  redactPersonal,
} from "../../workers/policy";
import { snippet, SNIPPET_MAX_CHARS } from "../../workers/policy-store";

/**
 * VRIP-09's detector.
 *
 * The two failure modes are not symmetric and the tests are weighted for it. A
 * missed block is one message a moderator handles late; a false block on
 * everyday banter is the room losing the register that makes it worth using at
 * all, every time it fires. So the false-positive block below is as long as the
 * detection block.
 */

const tier = (text: string) => detect(text).tier;

describe("normalisation", () => {
  it("defeats separators, repeats, case and Devanagari alike", () => {
    // Every one of these is one keystroke away from the last, which is why a
    // literal wordlist catches the first message and nothing after it.
    for (const written of [
      "mkc",
      "MKC",
      "M.K.C",
      "m k c",
      "m-k-c",
      "mkcc",
      "म क च",
    ]) {
      expect(normalise(written)).toBe("mkc");
    }
  });

  it("strips diacritics rather than treating them as different letters", () => {
    expect(normalise("chútiyá")).toBe(normalise("chutiya"));
  });

  it("does not merge separators between whole words", () => {
    // Only separators between single letters go. `e-mail` is not `email`, and
    // more importantly `quiet-ibex` stays two words the handle scan can see.
    expect(normalise("quiet-ibex")).toBe("quiet ibex");
  });

  it("leaves an ordinary sentence recognisable", () => {
    expect(normalise("Because the deadline moved")).toBe(
      "because the deadline moved",
    );
  });
});

describe("the profanity tier", () => {
  it("blocks profanity with nobody named", () => {
    expect(tier("bc this deadline is insane")).toBe("block");
    expect(tier("abey bc kal ka paper kaisa gaya")).toBe("block");
    expect(tier("mkc this assignment is endless")).toBe("block");
  });

  it("blocks the evasions too, because it normalises first", () => {
    expect(tier("m.k.c what a day")).toBe("block");
    expect(tier("MKCC yaar this is too much")).toBe("block");
    expect(tier("मादरचोद kya kar raha hai")).toBe("block");
  });
});

describe("the block tier", () => {
  it("blocks the same word once it is aimed at a handle", () => {
    expect(tier("bc quiet-ibex is at it again")).toBe("block");
    expect(tier("swift-heron bhosdike kya kar raha hai")).toBe("block");
  });

  it("blocks it when aimed at a named lecturer", () => {
    const found = detect("bc Prof Kulkarni changed the deadline again");
    expect(found.tier).toBe("block");
    // The honorific has to survive being scanned after `bc Prof`, which also
    // matches the pattern. A greedy scan reports the weaker `a named person`.
    expect(found.matches).toContain("an honorific and a name");
  });

  it("catches a named professor and an accusation with no profanity at all", () => {
    // The worst case in VRIP-09 and the one no swear list addresses. Neither
    // half scores on its own; the composite is the whole signal.
    expect(tier("Prof Kulkarni takes bribes for attendance")).toBe("block");
    expect(tier("Kulkarni sir harasses girls in the lab")).toBe("block");
    expect(tier("takes bribes for attendance")).toBe("none");
    expect(tier("Prof Kulkarni is teaching today")).toBe("confirm");
  });

  it("blocks a slur whether or not it names anyone", () => {
    expect(tier("he is such a chamar")).toBe("block");
  });

  it("measures proximity in words, so a distant target does not escalate (N/A now since all profanity is blocked)", () => {
    const near = `bc ${"word ".repeat(PROXIMITY_WINDOW_WORDS - 2)}quiet-ibex`;
    const far = `bc ${"word ".repeat(PROXIMITY_WINDOW_WORDS + 2)}quiet-ibex`;
    expect(tier(near)).toBe("block");
    expect(tier(far)).toBe("block"); // Now both are block
  });

  it("names the target in the matches, so the flag says why it blocked", () => {
    expect(detect("bc quiet-ibex is at it again").matches).toContain(
      "a handle",
    );
    expect(detect("bc quiet-ibex is at it again").targeted).toBe(true);
  });
});

describe("the confirm tier", () => {
  it("fires on personal data, which the composer turns into a dialog", () => {
    expect(tier("call me on 9876543210")).toBe("confirm");
    expect(tier("+91 98765 43210 is my number")).toBe("confirm");
    expect(tier("mail me at riya.sharma@vit.edu")).toBe("confirm");
    expect(tier("insta is @riya.sharma01")).toBe("confirm");
    expect(tier("ping me on t.me/riyasharma")).toBe("confirm");
  });

  it("does not escalate personal data next to a name", () => {
    // A phone number beside a name is still a phone number. Blocking it would
    // spend the interruption budget on the exact case the dialog exists for.
    expect(tier("Dr. Sharma can be reached on 9876543210")).toBe("confirm");
  });

  it("labels one thing once, so the dialog stays readable", () => {
    const found = detect("mail me at riya.sharma@vit.edu");
    expect(found.matches).toEqual(["an email address"]);
  });
});

describe("which tier wins, and what is therefore ephemeral (VRIP-10)", () => {
  it("names the kinds of personal data separately from the matches", () => {
    // The kinds are what a flag is allowed to record. They are labels by
    // construction, so there is no path from this array to a value.
    expect(detect("call me on 9876543210").personal).toEqual([
      "a phone number",
    ]);
    expect(detect("bc this deadline is insane").personal).toEqual([]);
  });

  it("makes a personal-data message ephemeral", () => {
    for (const text of [
      "call me on 9876543210",
      "mail me at riya.sharma@vit.edu",
      "insta is @riya.sharma01",
      "ping me on t.me/riyasharma",
    ]) {
      expect(isEphemeral(detect(text))).toBe(true);
    }
  });

  it("lets block outrank confirm, so profanity plus a number is blocked", () => {
    // Untargeted profanity is now block and a number is confirm. The higher of the
    // two decides.
    const found = detect("bc just call me on 9876543210");
    expect(found.tier).toBe("block");
    expect(isEphemeral(found)).toBe(false); // Because it is blocked, not ephemeral
  });

  it("lets block outrank confirm, so a targeted message is refused outright", () => {
    // A refused message is never delivered, so there is nothing to make
    // ephemeral. Reading this the other way round would turn every block into
    // a broadcast by adding a phone number to it.
    const found = detect("bc quiet-ibex call me on 9876543210");
    expect(found.tier).toBe("block");
    expect(isEphemeral(found)).toBe(false);
  });

  it("does not make a named individual ephemeral", () => {
    // The confirm tier covers two different things and only one of them is
    // personal data. Naming a lecturer is a message the room keeps.
    const found = detect("Prof Kulkarni moved the deadline again");
    expect(found.tier).toBe("confirm");
    expect(isEphemeral(found)).toBe(false);
  });

  it("leaves an ordinary message alone", () => {
    expect(isEphemeral(detect("because the deadline moved again"))).toBe(false);
  });
});

describe("redaction", () => {
  it("replaces the value with its kind and leaves the sentence readable", () => {
    const out = redactPersonal("bc quiet-ibex ring 9876543210 tonight");
    expect(out).not.toMatch(/\d/);
    expect(out).toContain("quiet-ibex");
    expect(out).toContain("a phone number");
  });

  it("takes every kind, not only the first", () => {
    const out = redactPersonal(
      "riya.sharma@vit.edu or 9876543210 or t.me/riyasharma",
    );
    expect(out).not.toContain("riya.sharma@vit.edu");
    expect(out).not.toContain("9876543210");
    expect(out).not.toContain("t.me/riyasharma");
  });

  it("leaves a message with nothing personal in it exactly as it was", () => {
    const plain = "does anyone have the lab manual for tomorrow";
    expect(redactPersonal(plain)).toBe(plain);
  });
});

describe("false-positive guards", () => {
  it("does not read `because` as `bc`", () => {
    expect(tier("because the deadline moved again")).toBe("none");
    expect(tier("i skipped it because of the lab")).toBe("none");
  });

  it("does not read the compere as an abbreviation", () => {
    expect(tier("the mc for the fest did a great job")).toBe("none");
    expect(tier("who is anchoring, we still need an MC")).toBe("none");
  });

  it("leaves ordinary sentences with two capitalised words alone", () => {
    // Two capitalised words are a target, never a tier on their own. This is
    // the difference between a heuristic that is usable and one that is not.
    expect(tier("See you at Main Gate tonight")).toBe("none");
    expect(tier("Monday Morning lecture is cancelled")).toBe("none");
    expect(tier("I think Data Structures is the hardest subject")).toBe("none");
    expect(tier("the Main Building lift is broken again")).toBe("none");
  });

  it("does not read `is it a good idea` as class IT-A", () => {
    // voss-ask's class regex is case-insensitive and does exactly this. Here a
    // division is a target that escalates profanity, so it must be upper case.
    expect(tier("is it a good idea bc i think not")).toBe("block");
    expect(tier("bc CS-A has a test tomorrow")).toBe("block");
  });

  it("leaves an accusation with nobody named alone", () => {
    expect(tier("the exam was a total scam honestly")).toBe("none");
    expect(tier("cheating in the exam is common here")).toBe("none");
  });
});

describe("snippets", () => {
  it("carries a window around the match, never the whole message", () => {
    const long = `${"hello ".repeat(40)}bc quiet-ibex${" bye".repeat(40)}`;
    const found = detect(long);
    const cut = snippet(long, found.at);

    expect(cut.length).toBeLessThanOrEqual(SNIPPET_MAX_CHARS + 6);
    expect(cut).toContain("quiet-ibex");
    expect(cut.length).toBeLessThan(long.length);
  });

  it("leaves a short message whole and unpadded", () => {
    expect(snippet("bc  quiet-ibex\n", 0)).toBe("bc quiet-ibex");
  });
});

describe("evasion and staff roles (found in production, 2026-08-13)", () => {
  it("catches a term with its vowels dropped", () => {
    expect(detect("fck").tier).toBe("block");
    expect(detect("bhnchd").tier).toBe("block");
  });

  it("treats an unnamed staff role as a target", () => {
    expect(detect("fck prof").tier).toBe("block");
    expect(detect("fuck professor").tier).toBe("block");
    expect(detect("prof takes bribes").tier).toBe("block");
  });

  it("blocks an evaded term beside a named member of staff", () => {
    expect(detect("fck Prof Kulkarni").tier).toBe("block");
  });

  it("leaves ordinary talk about staff alone", () => {
    expect(detect("which prof takes DBMS").tier).toBe("none");
    expect(detect("ask sir about the submission").tier).toBe("none");
  });

  it("does not fire on ordinary words that lose vowels", () => {
    for (const s of [
      "because the portal was down",
      "check the notes",
      "study group at 4",
    ]) {
      expect(detect(s).tier).toBe("none");
    }
  });
});
