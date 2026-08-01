import { describe, expect, it } from "vitest";
import { addDays } from "date-fns";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import fc from "fast-check";
import {
  buildBookingTrendSeries,
  buildRevenueSeries,
  getBookingRevenueByNight,
  getRevenueGranularity,
  summarizeNetCollectedCash,
  summarizeOverlappingGuests,
  type RevenueBookingLike,
} from "@/lib/admin-reports";

const date = (value: string) => new Date(`${value}T00:00:00.000Z`);

function booking(
  overrides: Partial<RevenueBookingLike> = {},
): RevenueBookingLike {
  return {
    id: "booking-1",
    checkIn: date("2026-04-07"),
    checkOut: date("2026-04-10"),
    finalPriceCents: 100,
    status: BookingStatus.PAID,
    guests: [],
    ...overrides,
  };
}

describe("admin reports helpers", () => {
  it("chooses daily, weekly, and monthly granularity at the boundaries", () => {
    const start = date("2026-04-01");
    expect(getRevenueGranularity(start, addDays(start, 13))).toBe("daily");
    expect(getRevenueGranularity(start, addDays(start, 14))).toBe("weekly");
    expect(getRevenueGranularity(start, addDays(start, 89))).toBe("weekly");
    expect(getRevenueGranularity(start, addDays(start, 90))).toBe("monthly");
  });

  it("allocates the whole price before slicing the selected stay nights", () => {
    const row = booking();
    expect(getBookingRevenueByNight(row, date("2026-04-07"), date("2026-04-09"))).toEqual([
      { date: "2026-04-07", revenueCents: 34 },
      { date: "2026-04-08", revenueCents: 33 },
      { date: "2026-04-09", revenueCents: 33 },
    ]);
    // If selection happened first this middle-night slice would receive all
    // 100 cents. It must retain its position in the full 34/33/33 allocation.
    expect(getBookingRevenueByNight(row, date("2026-04-08"), date("2026-04-08"))).toEqual([
      { date: "2026-04-08", revenueCents: 33 },
    ]);
  });

  it("preserves every integer cent across the full stay (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1, max: 60 }),
        (totalCents, nights) => {
          const checkIn = date("2026-01-01");
          const checkOut = addDays(checkIn, nights);
          const allocations = getBookingRevenueByNight(
            booking({ checkIn, checkOut, finalPriceCents: totalCents }),
            checkIn,
            addDays(checkOut, -1),
          );
          expect(allocations).toHaveLength(nights);
          expect(allocations.reduce((sum, value) => sum + value.revenueCents, 0)).toBe(
            totalCents,
          );
          expect(
            Math.max(...allocations.map((value) => value.revenueCents)) -
              Math.min(...allocations.map((value) => value.revenueCents)),
          ).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it("counts each booking once per overlapped bucket while summing nightly revenue", () => {
    const result = buildRevenueSeries(
      [booking({ finalPriceCents: 300 }), booking({ id: "booking-2", finalPriceCents: 600 })],
      date("2026-04-01"),
      date("2026-04-14"),
    );
    expect(result.granularity).toBe("daily");
    expect(result.data).toHaveLength(14);
    expect(result.data[6]).toMatchObject({
      periodStart: "2026-04-07",
      label: "Tue 7 Apr",
      revenueCents: 300,
      bookingCount: 2,
    });
  });

  it("does not count a multi-night booking more than once in a weekly bucket", () => {
    const result = buildRevenueSeries(
      [booking({ finalPriceCents: 300 })],
      date("2026-04-01"),
      date("2026-04-14"),
    );
    expect(result.granularity).toBe("daily");

    const weekly = buildRevenueSeries(
      [booking({ finalPriceCents: 300 })],
      date("2026-04-01"),
      date("2026-04-15"),
    );
    expect(weekly.granularity).toBe("weekly");
    expect(weekly.data.find((bucket) => bucket.periodStart === "2026-04-06")).toMatchObject({
      revenueCents: 300,
      bookingCount: 1,
    });
  });

  it("excludes non-report statuses instead of treating every non-cancelled row as revenue", () => {
    const result = buildRevenueSeries(
      [
        booking({ status: BookingStatus.DRAFT, finalPriceCents: 5000 }),
        booking({ id: "waitlist", status: BookingStatus.WAITLISTED, finalPriceCents: 7000 }),
        booking({ id: "paid", status: BookingStatus.PAID, finalPriceCents: 300 }),
      ],
      date("2026-04-01"),
      date("2026-04-14"),
    );
    expect(result.data.reduce((sum, bucket) => sum + bucket.revenueCents, 0)).toBe(300);
  });

  it("counts a spanning booking once in each overlapped week with its current status", () => {
    const trends = buildBookingTrendSeries(
      [booking({ checkIn: date("2026-04-12"), checkOut: date("2026-04-15") })],
      date("2026-04-10"),
      date("2026-04-25"),
    );
    expect(trends.map(({ week, total, paid }) => ({ week, total, paid }))).toEqual([
      { week: "2026-04-06", total: 1, paid: 1 },
      { week: "2026-04-13", total: 1, paid: 1 },
      { week: "2026-04-20", total: 0, paid: 0 },
    ]);
  });

  it("counts distinct guest rows only when an actual guest night overlaps", () => {
    const result = summarizeOverlappingGuests(
      [
        booking({
          guests: [
            {
              id: "member-guest",
              isMember: true,
              stayStart: date("2026-04-07"),
              stayEnd: date("2026-04-10"),
            },
            {
              id: "sparse-guest",
              isMember: false,
              stayStart: date("2026-04-07"),
              stayEnd: date("2026-04-10"),
              nights: [{ stayDate: date("2026-04-07") }, { stayDate: date("2026-04-09") }],
            },
          ],
        }),
      ],
      date("2026-04-08"),
      date("2026-04-08"),
    );
    // The member spans the selected night and is counted once. The sparse
    // guest's envelope spans it but their authoritative night rows do not.
    expect(result).toEqual({ totalGuests: 1, memberGuests: 1, nonMemberGuests: 0 });
  });

  it("derives net collected cash from payment aggregates without double-counting additions", () => {
    expect(
      summarizeNetCollectedCash([
        {
          status: PaymentStatus.PARTIALLY_REFUNDED,
          amountCents: 12_100,
          refundedAmountCents: 1_000,
        },
        {
          status: PaymentStatus.PENDING,
          amountCents: 9_000,
          refundedAmountCents: 0,
        },
      ]),
    ).toBe(11_100);
  });
});
