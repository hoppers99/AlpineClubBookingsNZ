import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { BookingStatus, PaymentStatus } from "@prisma/client";
import { REPORT_BOOKING_STATUSES } from "@/lib/admin-reports";

const mockLodgeFindUnique = vi.fn();
const mockPrisma = {
  booking: { findMany: vi.fn() },
  member: { count: vi.fn() },
  memberSubscription: { count: vi.fn() },
  lodge: { findUnique: mockLodgeFindUnique },
};

const mockAuth = vi.fn();
const mockRequireActiveSessionUser = vi.fn();

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/capacity", () => ({
  getOccupiedBedsForNight: vi.fn((_date: Date, bookings: Array<{ guests?: unknown[] }>) =>
    bookings.reduce((total, booking) => total + (booking.guests?.length ?? 0), 0)),
  LODGE_CAPACITY: 29,
}));
vi.mock("@/lib/finance-booking-metrics", () => ({
  resolveMetricsCapacityAndScope: vi.fn(async (lodgeId?: string) => ({
    capacity: 29,
    bookingLodgeWhere: lodgeId ? { lodgeId } : {},
  })),
}));

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

function reportBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "booking-1",
    createdAt: new Date("2025-01-01T10:00:00.000Z"),
    checkIn: day("2026-04-07"),
    checkOut: day("2026-04-10"),
    finalPriceCents: 100,
    status: BookingStatus.PAID,
    guests: [
      {
        id: "guest-member",
        isMember: true,
        stayStart: day("2026-04-07"),
        stayEnd: day("2026-04-10"),
        nights: [],
      },
      {
        id: "guest-non-member",
        isMember: false,
        stayStart: day("2026-04-09"),
        stayEnd: day("2026-04-10"),
        nights: [],
      },
    ],
    payment: {
      status: PaymentStatus.SUCCEEDED,
      amountCents: 100,
      refundedAmountCents: 0,
      additionalAmountCents: 0,
      additionalPaymentStatus: null,
    },
    ...overrides,
  };
}

function zeroMemberQueries() {
  mockPrisma.member.count.mockResolvedValue(0);
  mockPrisma.memberSubscription.count.mockResolvedValue(0);
}

describe("admin reports route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    });
    mockRequireActiveSessionUser.mockResolvedValue(null);
    zeroMemberQueries();
  });

  afterEach(() => vi.useRealTimers());

  it("selects a created-elsewhere booking by overlapping stay nights and slices cents after full allocation", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([reportBooking()]);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/reports?from=2026-04-08&to=2026-04-08"),
    );
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.summary).toMatchObject({
      totalBookings: 1,
      totalRevenueCents: 33,
      netCollectedCents: 100,
      totalGuests: 1,
      memberGuests: 1,
      nonMemberGuests: 0,
    });
    expect(data.revenue[0]).toMatchObject({ revenueCents: 33, bookingCount: 1 });
    expect(data.statusBreakdown).toEqual({
      pending: 0,
      paymentPending: 0,
      confirmed: 0,
      paid: 1,
      awaitingReview: 0,
      completed: 0,
    });

    const query = mockPrisma.booking.findMany.mock.calls[0][0];
    expect(query.where).toEqual({
      deletedAt: null,
      checkIn: { lte: day("2026-04-08") },
      checkOut: { gt: day("2026-04-08") },
      status: { in: [...REPORT_BOOKING_STATUSES] },
    });
    expect(query.where).not.toHaveProperty("createdAt");
    expect(mockPrisma.booking.findMany).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("uses the same stay cohort for status, guests, trends, lodge, and deleted scope", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: true });
    mockPrisma.booking.findMany.mockResolvedValue([
      reportBooking({ status: BookingStatus.PENDING }),
      reportBooking({ id: "review", status: BookingStatus.AWAITING_REVIEW, guests: [] }),
      reportBooking({ id: "completed", status: BookingStatus.COMPLETED, guests: [] }),
    ]);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/admin/reports?from=2026-04-07&to=2026-04-09&lodgeId=lodge-2&deleted=include",
      ),
    );
    const data = await response.json();

    expect(data.summary.totalBookings).toBe(3);
    expect(data.statusBreakdown).toMatchObject({ pending: 1, awaitingReview: 1, completed: 1 });
    expect(data.trends[0]).toMatchObject({ total: 3, pending: 1, awaitingReview: 1, completed: 1 });
    const queryWhere = mockPrisma.booking.findMany.mock.calls[0][0].where;
    expect(queryWhere).toMatchObject({ lodgeId: "lodge-2" });
    expect(queryWhere).not.toHaveProperty("deletedAt");
  }, 15_000);

  it("preserves outstanding-addition visibility beside payment-derived cash", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      reportBooking({
        finalPriceCents: 30_000,
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 9_000,
          refundedAmountCents: 0,
          additionalAmountCents: 21_000,
          additionalPaymentStatus: "PENDING",
        },
      }),
      reportBooking({
        id: "failed-addition",
        finalPriceCents: 10_000,
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 6_000,
          refundedAmountCents: 0,
          additionalAmountCents: 4_000,
          additionalPaymentStatus: "FAILED",
        },
      }),
    ]);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/reports?from=2026-04-07&to=2026-04-09"),
    );
    const data = await response.json();

    expect(data.summary.totalRevenueCents).toBe(40_000);
    expect(data.summary.netCollectedCents).toBe(15_000);
    expect(data.summary.outstandingAdditionalCents).toBe(25_000);
    expect(data.summary.outstandingAdditionalBookings).toBe(2);
  }, 15_000);

  it("rejects an unknown or inactive lodgeId before querying reports", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });
    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/admin/reports?from=2026-04-01&to=2026-04-14&lodgeId=lodge-2",
      ),
    );
    expect(response.status).toBe(400);
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });
});
