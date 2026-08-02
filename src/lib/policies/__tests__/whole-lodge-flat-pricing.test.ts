import { describe, expect, it } from "vitest";
import {
  priceWholeLodgeFlat,
  type WholeLodgeFlatSeason,
} from "@/lib/policies";

/**
 * Unit tests for the pure flat whole-lodge pricing math (#2338). The rule: each
 * night is charged its own covering season's flat rate; the whole stay flat
 * prices only when EVERY night is covered by a season with a flat rate set,
 * otherwise the caller falls back to per-guest pricing (returns null).
 */

const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function winter(flat: number | null): WholeLodgeFlatSeason {
  return {
    startDate: D("2026-07-01"),
    endDate: D("2026-08-01"),
    flatWholeLodgeNightCents: flat,
  };
}
function summer(flat: number | null): WholeLodgeFlatSeason {
  return {
    startDate: D("2026-08-02"),
    endDate: D("2026-09-01"),
    flatWholeLodgeNightCents: flat,
  };
}

describe("priceWholeLodgeFlat (#2338)", () => {
  it("charges nights x the covering season's flat rate within one season", () => {
    // 1 Aug + 2 Aug are both in a single winter-ending season here.
    const season: WholeLodgeFlatSeason = {
      startDate: D("2026-07-01"),
      endDate: D("2026-09-01"),
      flatWholeLodgeNightCents: 60000,
    };
    expect(priceWholeLodgeFlat(D("2026-08-01"), D("2026-08-03"), [season])).toBe(
      120000,
    );
  });

  it("sums each night at its OWN season's flat rate across a boundary", () => {
    // 1 Aug -> winter $600, 2 Aug -> summer $400 => $1000.
    expect(
      priceWholeLodgeFlat(D("2026-08-01"), D("2026-08-03"), [
        winter(60000),
        summer(40000),
      ]),
    ).toBe(100000);
  });

  it("returns null when a covering season has no flat rate set", () => {
    // 1 Aug covered but with no flat rate => cannot flat-price the stay.
    expect(
      priceWholeLodgeFlat(D("2026-08-01"), D("2026-08-03"), [
        winter(null),
        summer(40000),
      ]),
    ).toBeNull();
  });

  it("returns null when no active season covers a night", () => {
    // 2 Aug is uncovered (only the winter-ending season is present).
    expect(
      priceWholeLodgeFlat(D("2026-08-01"), D("2026-08-03"), [winter(60000)]),
    ).toBeNull();
  });

  it("returns null for an empty stay (no nights)", () => {
    expect(
      priceWholeLodgeFlat(D("2026-08-01"), D("2026-08-01"), [
        winter(60000),
        summer(40000),
      ]),
    ).toBeNull();
  });

  it("returns null when there are no seasons at all", () => {
    expect(priceWholeLodgeFlat(D("2026-08-01"), D("2026-08-03"), [])).toBeNull();
  });

  it("treats a zero flat rate as a real price, not 'unset'", () => {
    // A club that deliberately sets $0 (e.g. a work-party weekend) flat-prices
    // to 0, distinct from null which falls back to per-guest.
    const season: WholeLodgeFlatSeason = {
      startDate: D("2026-07-01"),
      endDate: D("2026-09-01"),
      flatWholeLodgeNightCents: 0,
    };
    expect(priceWholeLodgeFlat(D("2026-08-01"), D("2026-08-03"), [season])).toBe(
      0,
    );
  });
});
