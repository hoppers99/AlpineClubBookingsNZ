import { describe, expect, it } from "vitest";
import {
  PROMO_REDEMPTIONS_CSV_HEADER,
  buildPromoRedemptionCsvCells,
  buildPromoRedemptionsCsvContent,
  type PromoRedemptionCsvRow,
} from "@/lib/promo-redemptions-csv";

const ROW: PromoRedemptionCsvRow = {
  createdAt: "2026-07-10T02:00:00.000Z",
  // Leading "=" exercises the formula-injection guard once escaped.
  member: { name: "=Alice", email: "alice@example.com" },
  booking: {
    id: "bk-1",
    reference: "AAAAAA03",
    lodgeName: "Main Lodge",
    checkIn: "2026-08-01",
    checkOut: "2026-08-04",
    nights: 3,
  },
  eligibleGuestCount: null,
  discountCents: 5000,
  freeNightsUsed: 0,
  memberUseIndex: 2,
};

describe("buildPromoRedemptionCsvCells", () => {
  it("produces 13 cells aligned with the header", () => {
    const cells = buildPromoRedemptionCsvCells(ROW);
    expect(cells).toHaveLength(PROMO_REDEMPTIONS_CSV_HEADER.length);
    expect(PROMO_REDEMPTIONS_CSV_HEADER).toHaveLength(13);
  });

  it("formats cents as dollars, blanks a null guest count, and stringifies counts", () => {
    const cells = buildPromoRedemptionCsvCells(ROW);
    // Raw (unescaped) cells — escaping happens in the content builder.
    expect(cells[1]).toBe("=Alice");
    expect(cells[2]).toBe("alice@example.com");
    expect(cells[8]).toBe("3"); // nights
    expect(cells[9]).toBe(""); // null guest count
    expect(cells[10]).toBe("50.00"); // 5000c -> dollars
    expect(cells[11]).toBe("0"); // free nights
    expect(cells[12]).toBe("2"); // member use index
  });

  it("renders a non-null guest count", () => {
    const cells = buildPromoRedemptionCsvCells({
      ...ROW,
      eligibleGuestCount: 4,
    });
    expect(cells[9]).toBe("4");
  });
});

describe("buildPromoRedemptionsCsvContent", () => {
  it("emits a title line, a 13-column header, and formula-escaped data", () => {
    const content = buildPromoRedemptionsCsvContent("WINTER20", [ROW]);
    const lines = content.split("\n");
    expect(lines[0]).toBe("Promo code redemptions: WINTER20");
    // Header cells carry no commas, so a naive split is safe here.
    expect(lines[1].split(",")).toHaveLength(13);
    // The member name's leading "=" is neutralised with a single quote.
    expect(content).toContain("'=Alice");
  });

  it("handles an empty row set (title + header only)", () => {
    const content = buildPromoRedemptionsCsvContent("WINTER20", []);
    const lines = content.split("\n");
    expect(lines).toHaveLength(2);
  });
});
