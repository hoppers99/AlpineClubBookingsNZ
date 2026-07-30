import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockLodgeFindUnique = vi.fn();
const mockPrisma = {
  booking: {
    findMany: vi.fn(),
  },
  member: {
    count: vi.fn(),
  },
  memberSubscription: {
    count: vi.fn(),
  },
  // findUnique only (no findMany), so resolveMetricsCapacityAndScope keeps
  // taking its structural-mock branch while lodge validation can be exercised.
  lodge: {
    findUnique: mockLodgeFindUnique,
  },
};

const mockAuth = vi.fn();
const mockRequireActiveSessionUser = vi.fn();

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({
  auth: () => mockAuth(),
}));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn().mockResolvedValue(undefined),
  getLodgeCapacity: vi.fn().mockResolvedValue(29),
  getOccupiedBedsForNight: vi.fn((date: Date, bookings: Array<{ guests?: unknown[] }>) =>
    bookings.reduce((total, booking) => total + (booking.guests?.length ?? 0), 0)
  ),
  LODGE_CAPACITY: 29,
}));

describe("admin reports route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));

    mockAuth.mockResolvedValue({ user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] } });
    mockRequireActiveSessionUser.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns daily revenue data and current-season member stats", async () => {
    mockPrisma.booking.findMany
      .mockResolvedValueOnce([
        {
          createdAt: new Date("2026-04-07T10:00:00Z"),
          finalPriceCents: 12500,
          status: "PAID",
          guests: [{ isMember: true }, { isMember: false }],
          payment: null,
        },
        {
          createdAt: new Date("2026-04-10T10:00:00Z"),
          finalPriceCents: 5000,
          status: "CANCELLED",
          guests: [{ isMember: true }],
          payment: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          checkIn: new Date("2026-04-07T00:00:00Z"),
          checkOut: new Date("2026-04-09T00:00:00Z"),
          status: "PAID",
          guests: [{}, {}],
        },
      ]);

    mockPrisma.member.count.mockResolvedValueOnce(42).mockResolvedValueOnce(3);
    mockPrisma.memberSubscription.count
      .mockResolvedValueOnce(28)
      .mockResolvedValueOnce(7)
      .mockResolvedValueOnce(2);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest("http://localhost/api/admin/reports?from=2026-04-01&to=2026-04-14")
    );

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.revenueGranularity).toBe("daily");
    expect(data.revenue).toHaveLength(14);
    expect(data.revenue[6]).toMatchObject({
      periodStart: "2026-04-07",
      label: "Tue 7 Apr",
      revenueCents: 12500,
      bookingCount: 1,
    });
    expect(data.summary.totalBookings).toBe(1);
    expect(data.summary.totalRevenueCents).toBe(12500);
    expect(data.summary.totalGuests).toBe(2);
    expect(data.summary.memberGuests).toBe(1);
    expect(data.summary.nonMemberGuests).toBe(1);
    expect(data.memberStats).toEqual({
      totalActiveMembers: 42,
      paidMembers: 28,
      unpaidMembers: 7,
      overdueMembers: 2,
      newMembers: 3,
      currentSeasonYear: 2026,
      currentSeasonLabel: "2026/2027",
    });
    expect(data.occupancy).toHaveLength(14);

    expect(mockPrisma.booking.findMany.mock.calls[0][0].where.deletedAt).toBeNull();
    expect(mockPrisma.booking.findMany.mock.calls[1][0].where.deletedAt).toBeNull();

    expect(mockPrisma.memberSubscription.count.mock.calls).toHaveLength(3);
    expect(mockPrisma.memberSubscription.count.mock.calls[0][0]).toEqual({
      where: {
        seasonYear: 2026,
        status: "PAID",
        member: { active: true },
      },
    });

    expect(mockPrisma.member.count.mock.calls[1][0]).toMatchObject({
      where: {
        active: true,
        OR: [
          {
            joinedDate: {
              gte: expect.any(Date),
              lte: expect.any(Date),
            },
          },
          {
            joinedDate: null,
            createdAt: {
              gte: expect.any(Date),
              lte: expect.any(Date),
            },
          },
        ],
      },
    });
  }, 15_000);

  /*
    #2350: the revenue figure counts an upward change as money in hand even when
    the extra was never collected. The figure keeps its meaning — it is what the
    club BOOKED — and the shortfall is reported beside it so the two can be read
    against each other.
  */
  it("reports outstanding additional payments alongside booked revenue", async () => {
    mockPrisma.booking.findMany
      .mockResolvedValueOnce([
        {
          createdAt: new Date("2026-04-07T10:00:00Z"),
          finalPriceCents: 30_000,
          status: "PAID",
          guests: [{ isMember: true }],
          payment: {
            additionalAmountCents: 21_000,
            additionalPaymentStatus: "PENDING",
          },
        },
        {
          createdAt: new Date("2026-04-08T10:00:00Z"),
          finalPriceCents: 10_000,
          status: "PAID",
          guests: [{ isMember: true }],
          // FAILED rides along with PENDING wherever the owed test is applied.
          payment: {
            additionalAmountCents: 4_000,
            additionalPaymentStatus: "FAILED",
          },
        },
        {
          createdAt: new Date("2026-04-09T10:00:00Z"),
          finalPriceCents: 20_000,
          status: "PAID",
          guests: [{ isMember: true }],
          payment: {
            additionalAmountCents: 9_000,
            additionalPaymentStatus: "SUCCEEDED",
          },
        },
        {
          // Cancelled bookings are outside the revenue figure, so their
          // uncollected extra must be outside the shortfall too.
          createdAt: new Date("2026-04-10T10:00:00Z"),
          finalPriceCents: 50_000,
          status: "CANCELLED",
          guests: [{ isMember: true }],
          payment: {
            additionalAmountCents: 8_000,
            additionalPaymentStatus: "PENDING",
          },
        },
        {
          // #2350: not cancelled, but not a collectable obligation either. The
          // revenue figure counts every non-cancelled booking; the shortfall
          // uses the SHARED owed predicate, so this figure equals the one the
          // dashboard card, the sidebar badge and the chase cron report.
          createdAt: new Date("2026-04-11T10:00:00Z"),
          finalPriceCents: 15_000,
          status: "PAYMENT_PENDING",
          guests: [{ isMember: true }],
          payment: {
            additionalAmountCents: 7_000,
            additionalPaymentStatus: "PENDING",
          },
        },
      ])
      .mockResolvedValueOnce([]);

    mockPrisma.member.count.mockResolvedValueOnce(0).mockResolvedValueOnce(0);
    mockPrisma.memberSubscription.count
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/admin/reports?from=2026-04-01&to=2026-04-14"
      )
    );
    const data = await response.json();

    // The PAYMENT_PENDING booking is inside booked revenue…
    expect(data.summary.totalRevenueCents).toBe(75_000);
    // …and outside the shortfall, which follows the shared owed predicate.
    expect(data.summary.outstandingAdditionalCents).toBe(25_000);
    expect(data.summary.outstandingAdditionalBookings).toBe(2);
  }, 15_000);

  it("rejects an unknown or inactive lodgeId with 400 (Low 2)", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-2", active: false });

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/admin/reports?from=2026-04-01&to=2026-04-14&lodgeId=lodge-2"
      )
    );

    expect(response.status).toBe(400);
    // Rejected before any report query runs.
    expect(mockPrisma.booking.findMany).not.toHaveBeenCalled();
  });
});
