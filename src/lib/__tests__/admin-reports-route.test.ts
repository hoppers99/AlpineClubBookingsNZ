import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { NextRequest } from "next/server";
import {
  BookingStatus,
  PaymentStatus,
  PaymentTransactionKind,
  type Prisma,
} from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";

const EXPECTED_REPORT_STATUS_VALUES = [
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "AWAITING_REVIEW",
  "COMPLETED",
] as const;

const mockLodgeFindUnique = vi.fn();
const mockPrisma = {
  booking: { findMany: vi.fn() },
  member: { count: vi.fn() },
  memberSubscription: { count: vi.fn() },
  lodge: { findUnique: mockLodgeFindUnique },
};

const mockAuth = vi.fn();
const mockRequireActiveSessionUser = vi.fn();
const mockResolveMetricsCapacityAndScope = vi.fn(
  async (
    lodgeId?: string,
  ): Promise<{ capacity: number; bookingLodgeWhere: Prisma.BookingWhereInput }> => ({
    capacity: 29,
    bookingLodgeWhere: lodgeId ? { lodgeId } : {},
  }),
);
const mockLogger = {
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-guards", () => ({
  requireAdmin: async () =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(),
  requireActiveSessionUser: mockRequireActiveSessionUser,
}));
vi.mock("@/lib/logger", () => ({
  default: mockLogger,
}));
vi.mock("@/lib/finance-booking-metrics", () => ({
  resolveMetricsCapacityAndScope: mockResolveMetricsCapacityAndScope,
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
      transactions: [],
    },
    ...overrides,
  };
}

function zeroMemberQueries() {
  mockPrisma.member.count.mockResolvedValue(0);
  mockPrisma.memberSubscription.count.mockResolvedValue(0);
}

describe("admin reports route", () => {
  const hostTimeZone = captureHostTimeZone();

  beforeAll(() => {
    process.env.TZ = "Pacific/Auckland";
  });

  afterAll(() => {
    hostTimeZone.restore();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));
    mockAuth.mockResolvedValue({
      user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
    });
    mockRequireActiveSessionUser.mockResolvedValue(null);
    mockResolveMetricsCapacityAndScope.mockImplementation(async (lodgeId?: string) => ({
      capacity: 29,
      bookingLodgeWhere: lodgeId ? { lodgeId } : {},
    }));
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
      status: { in: [...EXPECTED_REPORT_STATUS_VALUES] },
    });
    expect(query.where).not.toHaveProperty("createdAt");
    expect(query.include.payment.select).toEqual({
      status: true,
      amountCents: true,
      refundedAmountCents: true,
      additionalAmountCents: true,
      additionalPaymentStatus: true,
      transactions: {
        where: { kind: PaymentTransactionKind.ADDITIONAL },
        select: { kind: true, status: true, amountCents: true },
      },
    });
    expect(mockPrisma.booking.findMany).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("enumerates inclusive NZ date-only occupancy nights without a DST day shift", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      reportBooking({
        checkIn: day("2026-09-25"),
        checkOut: day("2026-10-03"),
        guests: [
          {
            id: "dst-guest",
            isMember: true,
            stayStart: day("2026-09-25"),
            stayEnd: day("2026-10-03"),
            nights: [],
          },
        ],
      }),
    ]);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/admin/reports?from=2026-09-25&to=2026-09-27",
      ),
    );
    const data = await response.json();

    expect(data.occupancy).toEqual([
      { date: "2026-09-25", occupiedBeds: 1, availableBeds: 28, occupancyRate: 3 },
      { date: "2026-09-26", occupiedBeds: 1, availableBeds: 28, occupancyRate: 3 },
      { date: "2026-09-27", occupiedBeds: 1, availableBeds: 28, occupancyRate: 3 },
    ]);
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
    // PENDING/AWAITING_REVIEW belong to the base report cohort but must not
    // broaden the established PAID/COMPLETED occupancy cohort.
    expect(data.occupancy.every((night: { occupiedBeds: number }) => night.occupiedBeds === 0)).toBe(
      true,
    );
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
          transactions: [],
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
          transactions: [],
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

  it("surfaces the exact #2408 additional-ledger gap without changing cash arithmetic", async () => {
    mockPrisma.booking.findMany.mockResolvedValue([
      reportBooking({
        id: "booking-unproven-extra",
        finalPriceCents: 12_100,
        payment: {
          status: PaymentStatus.SUCCEEDED,
          amountCents: 10_000,
          refundedAmountCents: 0,
          additionalAmountCents: 2_100,
          additionalPaymentStatus: "SUCCEEDED",
          transactions: [],
        },
      }),
    ]);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/admin/reports?from=2026-04-07&to=2026-04-09",
      ),
    );
    const data = await response.json();

    expect(data.summary).toMatchObject({
      netCollectedCents: 10_000,
      additionalLedgerGapCents: 2_100,
      additionalLedgerGapBookings: 1,
    });
    expect(JSON.stringify(data)).not.toContain("booking-unproven-extra");
    expect(JSON.stringify(data)).not.toContain("transactions");
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingIds: ["booking-unproven-extra"],
        bookingCount: 1,
        additionalLedgerGapCents: 2_100,
        netCollectedCents: 10_000,
      }),
      expect.stringContaining("Net Collected Cash may understate"),
    );
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

  it("applies deleted=only and the strict post-migration default-lodge scope together", async () => {
    mockLodgeFindUnique.mockResolvedValue({ id: "lodge-default", active: true });
    mockResolveMetricsCapacityAndScope.mockResolvedValueOnce({
      capacity: 29,
      // Booking.lodgeId is NOT NULL after the completed expand/contract
      // migration. The historically named legacy-null helper is now a strict
      // default-lodge match; pin that current contract independently here.
      bookingLodgeWhere: { lodgeId: "lodge-default" },
    });
    mockPrisma.booking.findMany.mockResolvedValue([]);

    const { GET } = await import("@/app/api/admin/reports/route");
    const response = await GET(
      new NextRequest(
        "http://localhost/api/admin/reports?from=2026-04-07&to=2026-04-09&lodgeId=lodge-default&deleted=only",
      ),
    );

    expect(response.status).toBe(200);
    expect(mockPrisma.booking.findMany.mock.calls[0][0].where).toEqual({
      deletedAt: { not: null },
      lodgeId: "lodge-default",
      checkIn: { lte: day("2026-04-09") },
      checkOut: { gt: day("2026-04-07") },
      status: { in: [...EXPECTED_REPORT_STATUS_VALUES] },
    });
  }, 15_000);

  it("pins the completed Booking lodge backfill and NOT NULL contract", () => {
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const bookingModel = schema.match(/model Booking \{[\s\S]*?\n\}/)?.[0];
    expect(bookingModel).toContain(
      'lodgeId                   String             @default(dbgenerated("default_lodge_id()"))',
    );
    expect(bookingModel).not.toMatch(/lodgeId\s+String\?/);

    const contractMigration = readFileSync(
      join(
        process.cwd(),
        "prisma/migrations/20260708001100_multi_lodge_entity_lodge_id_not_null/migration.sql",
      ),
      "utf8",
    );
    expect(contractMigration).toContain(
      'UPDATE "Booking" SET "lodgeId" = default_lodge_id() WHERE "lodgeId" IS NULL;',
    );
    expect(contractMigration).toContain(
      'ALTER TABLE "Booking" ALTER COLUMN "lodgeId" SET NOT NULL;',
    );
  });
});
