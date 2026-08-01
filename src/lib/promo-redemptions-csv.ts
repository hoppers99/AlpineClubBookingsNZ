import { escapeCsvCell } from "./csv";
import { formatNZDateTime } from "@/lib/nzst-date";

// The 13-column export header. Kept as the single source of truth so the header
// row and every data row built by `buildPromoRedemptionCsvCells` stay aligned.
export const PROMO_REDEMPTIONS_CSV_HEADER = [
  "Redeemed",
  "Member",
  "Email",
  "Booking reference",
  "Booking ID",
  "Lodge",
  "Check-in",
  "Check-out",
  "Nights",
  "Guests",
  "Discount",
  "Free nights",
  "Member use #",
] as const;

// Structural subset of the panel's RedemptionRow needed to build a CSV row. The
// panel's richer row type is assignable to this.
export interface PromoRedemptionCsvRow {
  createdAt: string;
  member: { name: string; email: string };
  booking: {
    id: string;
    reference: string;
    lodgeName: string;
    checkIn: string;
    checkOut: string;
    nights: number;
  };
  eligibleGuestCount: number | null;
  discountCents: number;
  freeNightsUsed: number;
  memberUseIndex: number;
}

export function formatRedeemedAt(value: string): string {
  return formatNZDateTime(new Date(value));
}

/**
 * Build the 13 raw (unescaped) cells for one redemption row. Discount cents are
 * rendered as dollars with two decimals; a null guest count becomes an empty
 * cell. Escaping is applied by `buildPromoRedemptionsCsvContent`.
 */
export function buildPromoRedemptionCsvCells(
  row: PromoRedemptionCsvRow
): string[] {
  return [
    formatRedeemedAt(row.createdAt),
    row.member.name,
    row.member.email,
    row.booking.reference,
    row.booking.id,
    row.booking.lodgeName,
    row.booking.checkIn,
    row.booking.checkOut,
    String(row.booking.nights),
    row.eligibleGuestCount != null ? String(row.eligibleGuestCount) : "",
    (row.discountCents / 100).toFixed(2),
    String(row.freeNightsUsed),
    String(row.memberUseIndex),
  ];
}

/**
 * Assemble the full CSV document: a title line, the header row, then one row per
 * redemption. Every cell is escaped via `escapeCsvCell` so formula-injection and
 * delimiter characters are neutralised. Rows are joined with `\n` (matching the
 * existing client export semantics).
 */
export function buildPromoRedemptionsCsvContent(
  code: string,
  rows: PromoRedemptionCsvRow[]
): string {
  const table: string[][] = [];
  table.push([`Promo code redemptions: ${code}`]);
  table.push([...PROMO_REDEMPTIONS_CSV_HEADER]);
  for (const row of rows) {
    table.push(buildPromoRedemptionCsvCells(row));
  }
  return table
    .map((cells) => cells.map(escapeCsvCell).join(","))
    .join("\n");
}
