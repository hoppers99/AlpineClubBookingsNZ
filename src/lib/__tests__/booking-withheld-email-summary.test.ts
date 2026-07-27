import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * #2259 — the read behind the withheld-list banner.
 *
 * The banner is the compensating half of owner decision D10: an officer who
 * silenced a booking has to be told WHICH messages the member never received.
 * Two properties make that usable rather than merely present:
 *
 *   1. counts are EXACT and come from aggregates, so a chore-roster fan-out
 *      (one row per guest per date) cannot silently truncate the list — the
 *      previous `take: 100` could, with no disclosure;
 *   2. rows are grouped per KIND, so those same dozens of roster rows cannot
 *      bury the single cancellation the member most needs to hear about.
 */

const mocks = vi.hoisted(() => ({
  count: vi.fn(),
  groupBy: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailLog: {
      count: mocks.count,
      groupBy: mocks.groupBy,
      findMany: mocks.findMany,
    },
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { getWithheldBookingEmailSummary } from "@/lib/booking-email-suppression";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getWithheldBookingEmailSummary (#2259)", () => {
  it("reports exact counts per kind and never truncates a fan-out", async () => {
    mocks.count.mockResolvedValue(57);
    mocks.groupBy.mockResolvedValue([
      { templateName: "chore-roster", _count: { _all: 56 } },
      { templateName: "booking-cancelled", _count: { _all: 1 } },
    ]);
    mocks.findMany.mockResolvedValue([
      {
        templateName: "booking-cancelled",
        subject: "Your booking has been cancelled",
        createdAt: new Date("2026-07-20T02:00:00.000Z"),
      },
      {
        templateName: "chore-roster",
        subject: "Your chore for Saturday",
        createdAt: new Date("2026-07-19T21:00:00.000Z"),
      },
    ]);

    const summary = await getWithheldBookingEmailSummary("bk-1");

    expect(summary.total).toBe(57);
    expect(summary.groups).toHaveLength(2);
    // The cancellation is a first-class entry, not row 57 of a truncated list.
    expect(summary.groups[0]).toMatchObject({
      templateName: "booking-cancelled",
      label: "Booking Cancelled",
      count: 1,
      nothingToForward: false,
    });
    expect(summary.groups[1]).toMatchObject({
      templateName: "chore-roster",
      count: 56,
      // A roster email issues fresh 48-hour links; none were minted, so there
      // is nothing for the officer to forward.
      nothingToForward: true,
    });

    // No `take`: the row read is one-per-template, which the registry bounds.
    const findManyArgs = mocks.findMany.mock.calls[0][0];
    expect(findManyArgs.take).toBeUndefined();
    expect(findManyArgs.distinct).toEqual(["templateName"]);
    expect(findManyArgs.orderBy).toEqual({ createdAt: "desc" });
  });

  it("marks the never-minted payment link as nothing to forward", async () => {
    mocks.count.mockResolvedValue(1);
    mocks.groupBy.mockResolvedValue([
      { templateName: "split-guest-payment-link", _count: { _all: 1 } },
    ]);
    mocks.findMany.mockResolvedValue([
      {
        templateName: "split-guest-payment-link",
        subject: "Your payment link",
        createdAt: new Date("2026-07-20T02:00:00.000Z"),
      },
    ]);

    const summary = await getWithheldBookingEmailSummary("bk-1");
    expect(summary.groups[0].nothingToForward).toBe(true);
  });

  it("treats a relayable message as relayable", async () => {
    mocks.count.mockResolvedValue(1);
    mocks.groupBy.mockResolvedValue([
      { templateName: "xero-booking-invoice-email", _count: { _all: 1 } },
    ]);
    mocks.findMany.mockResolvedValue([
      {
        templateName: "xero-booking-invoice-email",
        subject: "Invoice INV-0042",
        createdAt: new Date("2026-07-20T02:00:00.000Z"),
      },
    ]);

    const summary = await getWithheldBookingEmailSummary("bk-1");
    // The invoice still exists in Xero and can be sent by hand from there.
    expect(summary.groups[0].nothingToForward).toBe(false);
    expect(summary.groups[0].label).toBe("Xero invoice email");
  });

  it("reads only deliberately-withheld rows for the booking", async () => {
    mocks.count.mockResolvedValue(0);
    mocks.groupBy.mockResolvedValue([]);
    mocks.findMany.mockResolvedValue([]);

    await getWithheldBookingEmailSummary("bk-42");

    for (const call of [
      mocks.count.mock.calls[0][0],
      mocks.groupBy.mock.calls[0][0],
      mocks.findMany.mock.calls[0][0],
    ]) {
      expect(call.where).toMatchObject({
        bookingId: "bk-42",
        status: "SKIPPED_NO_EMAILS",
      });
    }
  });

  it("never renders a count of zero for a kind it can see", async () => {
    // Defensive: a groupBy that somehow misses a template must not produce
    // "×0" beside a row that demonstrably exists.
    mocks.count.mockResolvedValue(1);
    mocks.groupBy.mockResolvedValue([]);
    mocks.findMany.mockResolvedValue([
      {
        templateName: "booking-confirmed",
        subject: "Your booking is confirmed",
        createdAt: new Date("2026-07-20T02:00:00.000Z"),
      },
    ]);

    const summary = await getWithheldBookingEmailSummary("bk-1");
    expect(summary.groups[0].count).toBe(1);
  });
});
