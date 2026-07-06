import { describe, expect, it } from "vitest";

import {
  damerauLevenshtein,
  isLikelyTypoCorrection,
} from "@/lib/guest-name-similarity";

describe("damerauLevenshtein", () => {
  it("returns 0 for identical strings", () => {
    expect(damerauLevenshtein("john smith", "john smith")).toBe(0);
  });

  it("counts a single insertion/deletion as 1", () => {
    expect(damerauLevenshtein("sara", "sarah")).toBe(1);
    expect(damerauLevenshtein("sarah", "sara")).toBe(1);
  });

  it("counts a single substitution as 1", () => {
    expect(damerauLevenshtein("smith", "smyth")).toBe(1);
  });

  it("counts an adjacent transposition as 1", () => {
    expect(damerauLevenshtein("jhon", "john")).toBe(1);
  });

  it("counts three substitutions across a swapped given name as 3", () => {
    // "john" -> "jane": o->a, h->n, n->e
    expect(damerauLevenshtein("john smith", "jane smith")).toBe(3);
  });
});

describe("isLikelyTypoCorrection", () => {
  describe("ALLOWS unambiguous spelling corrections of the same name", () => {
    it("fixes a transposed pair of letters (Jhon -> John)", () => {
      expect(isLikelyTypoCorrection("Jhon", "Doe", "John", "Doe")).toBe(true);
    });

    it("fixes a missing letter in the first name (Jon Smith -> John Smith)", () => {
      expect(isLikelyTypoCorrection("Jon", "Smith", "John", "Smith")).toBe(true);
    });

    it("fixes a missing trailing letter (Sara -> Sarah)", () => {
      expect(isLikelyTypoCorrection("Sara", "Lee", "Sarah", "Lee")).toBe(true);
    });

    it("ignores case and surrounding/collapsed whitespace (distance 0)", () => {
      expect(
        isLikelyTypoCorrection("  John  ", "  Smith  ", "John", "Smith"),
      ).toBe(true);
      expect(
        isLikelyTypoCorrection(" jhon ", "  smith ", "John", "Smith"),
      ).toBe(true);
    });

    it("allows a two-edit correction on a long enough full name", () => {
      // "Christofer Robinson" -> "Christopher Robinson": the first name is two
      // edits off (f -> ph); the surname is unchanged. Full-name distance 2,
      // longer length 20 so floor(0.25*20)=5 and the absolute cap of 2 governs.
      expect(
        isLikelyTypoCorrection(
          "Christofer",
          "Robinson",
          "Christopher",
          "Robinson",
        ),
      ).toBe(true);
    });
  });

  describe("REJECTS anything that could be a different person", () => {
    it("rejects a same-surname given-name swap (John Smith -> Jane Smith)", () => {
      expect(isLikelyTypoCorrection("John", "Smith", "Jane", "Smith")).toBe(
        false,
      );
    });

    it("rejects a full swap (John Smith -> Aroha Ngata)", () => {
      expect(isLikelyTypoCorrection("John", "Smith", "Aroha", "Ngata")).toBe(
        false,
      );
    });

    it("rejects an added name token (John -> Johnathan Smith)", () => {
      // First name gains a second token: not a typo, could be a new person.
      expect(
        isLikelyTypoCorrection("John", "Smith", "Johnathan Smith", "Smith"),
      ).toBe(false);
    });

    it("rejects a removed name token", () => {
      expect(
        isLikelyTypoCorrection("Mary Jane", "Smith", "Mary", "Smith"),
      ).toBe(false);
    });

    it("rejects dropping the first name to blank (John -> '')", () => {
      expect(isLikelyTypoCorrection("John", "Smith", "", "Smith")).toBe(false);
      expect(isLikelyTypoCorrection("John", "Smith", "   ", "Smith")).toBe(
        false,
      );
    });

    it("rejects dropping the last name to blank", () => {
      expect(isLikelyTypoCorrection("John", "Smith", "John", "")).toBe(false);
    });
  });

  describe("threshold boundary behaviour", () => {
    it("rejects a three-edit change even on a long name (> 2 edits)", () => {
      // "aaaaaaaa bbbbbbbb" -> "cccaaaaa bbbbbbbb": 3 substitutions, distance 3,
      // longer length 17 (25% = 4) but the absolute cap of 2 edits still wins.
      expect(
        isLikelyTypoCorrection(
          "aaaaaaaa",
          "bbbbbbbb",
          "cccaaaaa",
          "bbbbbbbb",
        ),
      ).toBe(false);
    });

    it("rejects a two-edit change when 25% of the longer name is below 2", () => {
      // Full names "an bo" (5) vs "xy bo" (5): distance 2, but floor(0.25*5)=1,
      // so the proportional cap rejects it.
      expect(isLikelyTypoCorrection("an", "bo", "xy", "bo")).toBe(false);
    });

    it("allows a two-edit change when 25% of the longer name reaches 2", () => {
      // Full names "robyn tana" / "robin tane" are length 10, floor(0.25*10)=2,
      // total distance 2 (y->i, a->e) -> allowed at the inclusive boundary.
      expect(
        isLikelyTypoCorrection("Robyn", "Tana", "Robin", "Tane"),
      ).toBe(true);
    });
  });
});
