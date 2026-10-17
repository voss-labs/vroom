import { describe, expect, it } from "vitest";

import { detect, isEphemeral, normalise } from "../../workers/policy";

/**
 * VRIP-14: the evasions a review found in VRIP-09's normaliser, and the two
 * categories it never listed. As in `policy.test.ts`, the false-positive block
 * is as long as the detection block: a refused joke costs the room more than a
 * missed one.
 */

const tier = (text: string) => detect(text).tier;

describe("evasions that used to get through", () => {
  it("rejoins spaced letters and folds the digraph they spell", () => {
    expect(normalise("c h u t i y a")).toBe(normalise("chutiya"));
    expect(tier("c h u t i y a hai tu")).toBe("block");
    expect(tier("b h e n c h o d")).toBe("block");
  });

  it("reads digits and symbols as the letters they stand in for", () => {
    expect(tier("chut1ya")).toBe("block");
    expect(tier("b1tch")).toBe("block");
    expect(tier("a$$hole")).toBe("block");
  });

  it("reads a masked letter through the word's skeleton", () => {
    expect(tier("f*ck this")).toBe("block");
    expect(tier("f**k this")).toBe("block");
    expect(tier("ch*tiya")).toBe("block");
    expect(tier("b*tch")).toBe("block");
  });

  it("does not let an invisible character split a word", () => {
    expect(tier("chu\u200btiya")).toBe("block");
    expect(tier("f\u200cu\u200dck")).toBe("block");
  });

  it("reads Cyrillic and Greek look-alikes as Latin", () => {
    expect(tier("\u0441hutiya")).toBe("block");
    expect(tier("CHUTIY\u0410")).toBe("block");
    expect(tier("f\u03c5ck")).toBe("block");
  });

  it("folds full-width and mathematical letters", () => {
    expect(tier("\uff46\uff55\uff43\uff4b")).toBe("block");
    expect(tier("\u{1d41f}\u{1d42e}\u{1d41c}\u{1d424}")).toBe("block");
  });

  it("still escalates an evaded word beside a target", () => {
    expect(tier("c h u t i y a Prof Kulkarni")).toBe("block");
    expect(tier("quiet-ibex is a ch*tiya")).toBe("block");
  });
});

describe("threats (VRIP-14)", () => {
  it("blocks violence aimed at the reader with nobody named", () => {
    expect(tier("I will beat you up after class")).toBe("block");
    expect(tier("i know where you live")).toBe("block");
    expect(tier("tujhe maar dunga kal")).toBe("block");
    expect(tier("goli maar dunga")).toBe("block");
    expect(detect("I will kill you").matches).toContain("a threat");
  });

  it("blocks a sexual threat that used to score count", () => {
    expect(tier("I will rape you")).toBe("block");
  });

  it("explains itself in the refusal labels", () => {
    expect(detect("I will beat you up").matches).toEqual(["a threat"]);
  });
});

describe("self-harm incitement (VRIP-14)", () => {
  it("blocks telling someone to harm themselves", () => {
    expect(tier("everyone hates you, kill yourself")).toBe("block");
    expect(tier("kys")).toBe("block");
    expect(tier("tu mar ja")).toBe("block");
    expect(tier("go die")).toBe("block");
    expect(detect("kill yourself").matches).toEqual(["encouraging self-harm"]);
  });

  it("never blocks a student writing about themselves", () => {
    // Refusing someone in distress would be the worst response there is.
    expect(tier("I want to kill myself")).toBe("none");
    expect(tier("sometimes i feel like dying")).toBe("none");
  });
});

describe("what VRIP-14 must leave alone", () => {
  it("keeps everyday exaggeration legal", () => {
    expect(tier("this assignment is killing me")).toBe("none");
    expect(tier("you killed it on stage yesterday")).toBe("none");
    expect(tier("I died laughing")).toBe("none");
  });

  it("guards the Hinglish phrases that are not violence", () => {
    expect(tier("aaj ka lecture maar dunga")).toBe("none");
    expect(tier("garmi se mar ja raha hu")).toBe("none");
  });

  it("does not index phrases by their skeleton", () => {
    // `beat you` elided is `bt y`, which is how `but y` gets typed.
    expect(tier("bt y not")).toBe("none");
    expect(tier("but you said so")).toBe("none");
  });

  it("does not read ordinary digits as masks that match a term", () => {
    for (const text of [
      "meet at 4pm",
      "1st year hostel",
      "3rd floor lab",
      "cs101 notes",
      "2nd sem results",
    ]) {
      expect(tier(text)).toBe("none");
    }
  });

  it("leaves markdown-style stars and plain punctuation alone", () => {
    expect(tier("**important** submit by friday!")).toBe("none");
    expect(tier("wow!! great fest")).toBe("none");
  });

  it("still sees personal data and handles around a mask character", () => {
    expect(tier("mail me at riya.sharma@vit.edu")).toBe("confirm");
    expect(isEphemeral(detect("insta is @riya.sharma01"))).toBe(true);
    expect(tier("bc @quiet-ibex is at it again")).toBe("block");
  });
});
