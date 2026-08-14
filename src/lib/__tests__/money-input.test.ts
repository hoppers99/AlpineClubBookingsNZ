import { describe, expect, it } from "vitest";
import {
  parseDecimalDollarsToCents,
  parseSignedDecimalDollarsToCents,
} from "@/lib/money-input";

describe("parseDecimalDollarsToCents", () => {
  it.each([
    ["0", 0], ["1", 100], ["1.2", 120], ["1.23", 123],
    [" 150.05 ", 15005], ["21474836.47", 2_147_483_647],
  ])("parses %s exactly", (input, expected) => {
    expect(parseDecimalDollarsToCents(input)).toBe(expected);
  });

  it.each(["", "-1", ".5", "01", "1.234", "1e2", "1,000", "21474836.48"])(
    "rejects %s",
    (input) => expect(parseDecimalDollarsToCents(input)).toBeNull(),
  );

  /*
    #2685 — the decimal values a binary double cannot hold, and the malformed
    entries `parseFloat` used to accept.

    `Math.round(parseFloat("1.005") * 100)` is 100, not 101: 1.005 is stored as
    1.00499999999999989... and scaling it lands just under the half-cent. Reading
    the digit groups as integers has no such boundary, so "1.005" is simply not a
    valid amount and is refused — the product rule this repository enforces
    everywhere (INV-MONEY-001, INV-MONEY-003).
  */
  it.each([
    ["1.005", "the classic binary-float half-cent"],
    ["2.675", "rounds DOWN through a float, not up"],
    ["1.115", "another sub-cent boundary"],
    ["8.165", "and another"],
  ])("refuses %s outright rather than guessing a cent (%s)", (input) => {
    expect(parseDecimalDollarsToCents(input)).toBeNull();
  });

  it.each([
    "50abc",
    "abc",
    "12.34.56",
    "1..2",
    "$45.00",
    "45.00$",
    "  ",
    "Infinity",
    "NaN",
    "0x10",
    "1_000",
    "+5",
    "5.",
    "1e-2",
  ])("refuses the malformed entry %s instead of coercing it", (input) => {
    expect(parseDecimalDollarsToCents(input)).toBeNull();
  });

  it("never returns a non-integer", () => {
    for (const input of ["0.01", "0.99", "12.34", "999.99", "21474836.47"]) {
      const cents = parseDecimalDollarsToCents(input);
      expect(Number.isInteger(cents)).toBe(true);
    }
  });

  it("is exact where float arithmetic is not", () => {
    // Each of these is a cent out (or at the edge of being one) if converted as
    // Math.round(parseFloat(x) * 100) on some inputs; the digit-group parse
    // agrees with the decimal text by construction.
    const cases: Array<[string, number]> = [
      ["0.07", 7],
      ["0.29", 29],
      ["1.13", 113],
      ["4.35", 435],
      ["8.87", 887],
      ["1234.56", 123456],
    ];
    for (const [input, expected] of cases) {
      expect(parseDecimalDollarsToCents(input)).toBe(expected);
    }
  });
});

describe("parseSignedDecimalDollarsToCents", () => {
  it.each([
    ["25", 2500],
    ["25.00", 2500],
    ["-25.00", -2500],
    ["-0.01", -1],
    [" -150.05 ", -15005],
    ["+25.00", 2500],
  ])("parses the signed amount %s", (input, expected) => {
    expect(parseSignedDecimalDollarsToCents(input)).toBe(expected);
  });

  it("keeps zero canonical rather than returning -0", () => {
    expect(Object.is(parseSignedDecimalDollarsToCents("-0"), 0)).toBe(true);
    expect(Object.is(parseSignedDecimalDollarsToCents("-0.00"), 0)).toBe(true);
  });

  it("inherits the canonical grammar, precision and range rules", () => {
    for (const input of ["-1.005", "-50abc", "-", "--5", "-1,000", "-21474836.48"]) {
      expect(parseSignedDecimalDollarsToCents(input)).toBeNull();
    }
  });
});
