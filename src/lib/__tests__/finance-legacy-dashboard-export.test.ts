import { beforeEach, describe, expect, it, vi } from "vitest";
import { BookingStatus } from "@prisma/client";

const { mockFindMany } = vi.hoisted(() => ({
  mockFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: {
      findMany: mockFindMany,
    },
  },
}));

import { getLegacyDashboardBookingExport } from "@/lib/finance-legacy-dashboard-export";

describe("finance legacy dashboard export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindMany.mockResolvedValue([
      {
        id: "booking-realized",
        checkIn: new Date("2026-04-08T00:00:00.000Z"),
        checkOut: new Date("2026-04-12T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 40000,
        createdAt: new Date("2026-03-20T00:00:00.000Z"),
        guests: [{ id: "guest-1" }, { id: "guest-2" }],
      },
      {
        id: "booking-forward",
        checkIn: new Date("2026-05-01T00:00:00.000Z"),
        checkOut: new Date("2026-05-03T00:00:00.000Z"),
        status: BookingStatus.PENDING,
        finalPriceCents: 10000,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        guests: [{ id: "guest-3" }],
      },
    ]);
  });

  it("exports realized and forward booking rows without member PII", async () => {
    const result = await getLegacyDashboardBookingExport({
      historyStartDate: "2026-04-01",
      asOfDate: "2026-04-10",
    });

    expect(mockFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          id: true,
          guests: { select: { id: true } },
        }),
      })
    );
    expect(mockFindMany.mock.calls[0][0].select).not.toHaveProperty("member");
    expect(result.bookings).toEqual([
      {
        booking_id: "booking-realized",
        start_date: "2026-04-08",
        end_date: "2026-04-11",
        created_date: "2026-03-20",
        status: BookingStatus.PAID,
        guests: 2,
        nights: 3,
        guest_nights: 6,
        total: 300,
      },
    ]);
    expect(result.forward_bookings).toEqual([
      {
        booking_id: "booking-realized",
        start_date: "2026-04-11",
        end_date: "2026-04-12",
        created_date: "2026-03-20",
        status: BookingStatus.PAID,
        guests: 2,
        nights: 1,
        guest_nights: 2,
        total: 100,
        pipeline_bucket: "COMMITTED",
        days_until_arrival: 0,
        month_of_stay: "2026-04",
      },
      {
        booking_id: "booking-forward",
        start_date: "2026-05-01",
        end_date: "2026-05-03",
        created_date: "2026-04-01",
        status: BookingStatus.PENDING,
        guests: 1,
        nights: 2,
        guest_nights: 2,
        total: 100,
        pipeline_bucket: "AT_RISK",
        days_until_arrival: 21,
        month_of_stay: "2026-05",
      },
    ]);
  });

  it("reports created_date on the club calendar, not the UTC day (#2697)", async () => {
    // 2026-04-08 09:30 in Pacific/Auckland: a booking made in the NZ morning
    // still falls on the previous UTC day. `createdAt` is a `DateTime` instant,
    // unlike start_date/end_date, which are `@db.Date` lodge nights.
    const createdAt = new Date("2026-04-07T21:30:00.000Z");
    expect(createdAt.toISOString().slice(0, 10)).toBe("2026-04-07");

    mockFindMany.mockResolvedValue([
      {
        id: "booking-nz-morning",
        checkIn: new Date("2026-04-08T00:00:00.000Z"),
        checkOut: new Date("2026-04-10T00:00:00.000Z"),
        status: BookingStatus.PAID,
        finalPriceCents: 20000,
        createdAt,
        guests: [{ id: "guest-1" }],
      },
    ]);

    const result = await getLegacyDashboardBookingExport({
      historyStartDate: "2026-04-01",
      asOfDate: "2026-04-10",
    });

    expect(result.bookings[0].created_date).toBe("2026-04-08");
    // The lodge nights are date-only and must be untouched by the fix.
    expect(result.bookings[0].start_date).toBe("2026-04-08");
    expect(result.bookings[0].end_date).toBe("2026-04-10");
  });

  it("rejects malformed export dates before querying", async () => {
    await expect(
      getLegacyDashboardBookingExport({
        historyStartDate: "04-01-2026",
        asOfDate: "2026-04-10",
      })
    ).rejects.toThrow("historyStartDate must use YYYY-MM-DD");
    expect(mockFindMany).not.toHaveBeenCalled();
  });
});
