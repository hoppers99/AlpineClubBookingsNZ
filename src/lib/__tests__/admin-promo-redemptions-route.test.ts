import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { emptyAdminPermissionMatrix } from "@/lib/admin-permissions";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireActiveSessionUser: vi.fn(),
  prisma: {
    promoCode: { findUnique: vi.fn() },
    lodge: { findUnique: vi.fn() },
    promoRedemption: {
      aggregate: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/auth", () => ({
  auth: mocks.auth,
}));

vi.mock("@/lib/session-guards", () => ({
  // Forward the route's explicit permission requirement so the view/edit
  // matrix is exercised end-to-end.
  requireAdmin: async (options: unknown) =>
    (await import("./helpers/require-admin-mock")).evaluateRequireAdminMock(
      options as never,
    ),
  requireActiveSessionUser: mocks.requireActiveSessionUser,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: mocks.prisma,
}));

import { GET } from "@/app/api/admin/promo-codes/[id]/redemptions/route";

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

function req(url: string) {
  return new NextRequest(url);
}

function bookingsUser(level: "view" | "edit" | "none") {
  return {
    user: {
      id: "admin-1",
      role: "ADMIN",
      adminPermissionMatrix: { ...emptyAdminPermissionMatrix(), bookings: level },
    },
  };
}

const BASE_URL = "http://localhost/api/admin/promo-codes/pc-1/redemptions";

const PROMO_CODE = {
  id: "pc-1",
  code: "WINTER20",
  description: "Winter discount",
  type: "PERCENTAGE",
  active: true,
  archivedAt: null,
  internal: false,
  currentRedemptions: 3,
  maxRedemptionsTotal: 10,
  maxUniqueMembersTotal: null,
  maxUsesPerMember: 2,
  lifetimeFreeNightsCap: null,
};

// asc history: m1 used r1 then r3, m2 used r2 → m1's r3 is use #2.
const ORDERED_FOR_CODE = [
  { id: "r1", memberId: "m1" },
  { id: "r2", memberId: "m2" },
  { id: "r3", memberId: "m1" },
];

const ROWS = [
  {
    id: "r3",
    createdAt: new Date("2026-07-10T02:00:00.000Z"),
    member: { id: "m1", firstName: "Alice", lastName: "Alpha", email: "alice@example.com" },
    booking: {
      id: "bk-aaaaaa03",
      checkIn: new Date("2026-08-01T00:00:00.000Z"),
      checkOut: new Date("2026-08-04T00:00:00.000Z"),
      lodge: { id: "lodge-1", name: "Main Lodge" },
    },
    eligibleGuestCount: 2,
    discountCents: 5000,
    freeNightsUsed: 0,
    allocations: [
      {
        memberId: "m1",
        member: { id: "m1", firstName: "Alice", lastName: "Alpha" },
        discountCents: 3000,
        freeNightsUsed: 0,
      },
      {
        memberId: "g1",
        member: { id: "g1", firstName: "Bob", lastName: "Beta" },
        discountCents: 2000,
        freeNightsUsed: 0,
      },
    ],
  },
  {
    id: "r2",
    createdAt: new Date("2026-07-05T02:00:00.000Z"),
    member: { id: "m2", firstName: "Carol", lastName: "Gamma", email: "carol@example.com" },
    booking: {
      id: "bk-bbbbbb02",
      checkIn: new Date("2026-08-10T00:00:00.000Z"),
      checkOut: new Date("2026-08-12T00:00:00.000Z"),
      lodge: { id: "lodge-1", name: "Main Lodge" },
    },
    eligibleGuestCount: 1,
    discountCents: 2500,
    freeNightsUsed: 1,
    allocations: [
      {
        memberId: "m2",
        member: { id: "m2", firstName: "Carol", lastName: "Gamma" },
        discountCents: 2500,
        freeNightsUsed: 1,
      },
    ],
  },
  {
    id: "r1",
    createdAt: new Date("2026-07-01T02:00:00.000Z"),
    member: { id: "m1", firstName: "Alice", lastName: "Alpha", email: "alice@example.com" },
    booking: {
      id: "bk-cccccc01",
      checkIn: new Date("2026-08-20T00:00:00.000Z"),
      checkOut: new Date("2026-08-21T00:00:00.000Z"),
      lodge: { id: "lodge-1", name: "Main Lodge" },
    },
    eligibleGuestCount: 1,
    discountCents: 1000,
    freeNightsUsed: 0,
    allocations: [
      {
        memberId: "m1",
        member: { id: "m1", firstName: "Alice", lastName: "Alpha" },
        discountCents: 1000,
        freeNightsUsed: 0,
      },
    ],
  },
];

function seedHappyPath(codeOverride: Record<string, unknown> = {}) {
  mocks.prisma.promoCode.findUnique.mockResolvedValue({ ...PROMO_CODE, ...codeOverride });
  // Promise.all order: aggregate(all), groupBy(all), aggregate(filtered),
  // groupBy(filtered), findMany(orderedForCode), findMany(rows).
  mocks.prisma.promoRedemption.aggregate
    .mockResolvedValueOnce({
      _count: { _all: 3 },
      _sum: { discountCents: 8500, freeNightsUsed: 1 },
    })
    .mockResolvedValueOnce({
      _count: { _all: 3 },
      _sum: { discountCents: 8500, freeNightsUsed: 1 },
    });
  mocks.prisma.promoRedemption.groupBy
    .mockResolvedValueOnce([{ memberId: "m1" }, { memberId: "m2" }])
    .mockResolvedValueOnce([{ memberId: "m1" }, { memberId: "m2" }]);
  mocks.prisma.promoRedemption.findMany
    .mockResolvedValueOnce(ORDERED_FOR_CODE)
    .mockResolvedValueOnce(ROWS);
}

describe("GET /api/admin/promo-codes/[id]/redemptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue(bookingsUser("view"));
    mocks.requireActiveSessionUser.mockResolvedValue(null);
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.auth.mockResolvedValue(null);
    const res = await GET(req(BASE_URL), params("pc-1"));
    expect(res.status).toBe(401);
    expect(mocks.prisma.promoCode.findUnique).not.toHaveBeenCalled();
  });

  it("returns 403 without bookings access", async () => {
    mocks.auth.mockResolvedValue(bookingsUser("none"));
    const res = await GET(req(BASE_URL), params("pc-1"));
    expect(res.status).toBe(403);
    expect(mocks.prisma.promoCode.findUnique).not.toHaveBeenCalled();
  });

  it("allows bookings view access (edit is not required)", async () => {
    seedHappyPath();
    const res = await GET(req(BASE_URL), params("pc-1"));
    expect(res.status).toBe(200);
  });

  it("returns 404 for an unknown code", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(null);
    const res = await GET(req(BASE_URL), params("missing"));
    expect(res.status).toBe(404);
    expect(mocks.prisma.promoRedemption.aggregate).not.toHaveBeenCalled();
  });

  it("returns filtered and all-time totals with summed discount cents", async () => {
    seedHappyPath();
    const res = await GET(req(BASE_URL), params("pc-1"));
    const body = await res.json();

    expect(body.totals.all).toEqual({
      redemptions: 3,
      uniqueMembers: 2,
      discountCents: 8500,
      freeNightsUsed: 1,
    });
    expect(body.totals.filtered).toEqual({
      redemptions: 3,
      uniqueMembers: 2,
      discountCents: 8500,
      freeNightsUsed: 1,
    });
    expect(body.code.caps.maxRedemptionsTotal).toBe(10);
    expect(body.pagination.total).toBe(3);
  });

  it("computes memberUseIndex from full redemption history", async () => {
    seedHappyPath();
    const res = await GET(req(BASE_URL), params("pc-1"));
    const body = await res.json();
    const byId = Object.fromEntries(
      body.rows.map((r: { id: string; memberUseIndex: number }) => [r.id, r.memberUseIndex]),
    );
    // m1: r1 -> use #1, r3 -> use #2. m2: r2 -> use #1.
    expect(byId.r1).toBe(1);
    expect(byId.r3).toBe(2);
    expect(byId.r2).toBe(1);
  });

  it("includes the per-member split only on multi-member bookings", async () => {
    seedHappyPath();
    const res = await GET(req(BASE_URL), params("pc-1"));
    const body = await res.json();
    const rowsById = Object.fromEntries(
      body.rows.map((r: { id: string }) => [r.id, r]),
    );
    // r3 has two allocations -> included and named.
    expect(rowsById.r3.allocations).toHaveLength(2);
    expect(rowsById.r3.allocations[0]).toMatchObject({
      name: "Alice Alpha",
      discountCents: 3000,
    });
    // Single-allocation redemptions omit the split.
    expect(rowsById.r1.allocations).toEqual([]);
    expect(rowsById.r2.allocations).toEqual([]);
  });

  it("maps booking reference, nights, and lodge without shifting stay dates", async () => {
    seedHappyPath();
    const res = await GET(req(BASE_URL), params("pc-1"));
    const body = await res.json();
    const r3 = body.rows.find((r: { id: string }) => r.id === "r3");
    expect(r3.booking.reference).toBe("AAAAAA03");
    expect(r3.booking.checkIn).toBe("2026-08-01");
    expect(r3.booking.checkOut).toBe("2026-08-04");
    expect(r3.booking.nights).toBe(3);
    expect(r3.booking.lodgeName).toBe("Main Lodge");
    expect(r3.discountCents).toBe(5000);
  });

  it("applies date-range and lodge filters to the redemption query", async () => {
    seedHappyPath();
    mocks.prisma.lodge.findUnique.mockResolvedValue({ id: "lodge-1" });

    const res = await GET(
      req(`${BASE_URL}?from=2026-07-01&to=2026-07-31&lodgeId=lodge-1`),
      params("pc-1"),
    );
    expect(res.status).toBe(200);

    // The rows findMany is the 2nd findMany call; its where is the filtered set.
    const rowsCall = mocks.prisma.promoRedemption.findMany.mock.calls[1][0];
    expect(rowsCall.where.promoCodeId).toBe("pc-1");
    expect(rowsCall.where.booking).toEqual({ lodgeId: "lodge-1" });
    expect(rowsCall.where.createdAt.gte).toBeInstanceOf(Date);
    expect(rowsCall.where.createdAt.lte).toBeInstanceOf(Date);
    expect(rowsCall.where.createdAt.gte.getTime()).toBeLessThan(
      rowsCall.where.createdAt.lte.getTime(),
    );
  });

  it("rejects an unknown lodge filter with 400", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(PROMO_CODE);
    mocks.prisma.lodge.findUnique.mockResolvedValue(null);
    const res = await GET(req(`${BASE_URL}?lodgeId=ghost`), params("pc-1"));
    expect(res.status).toBe(400);
    expect(mocks.prisma.promoRedemption.aggregate).not.toHaveBeenCalled();
  });

  it("rejects a reversed date range with 400", async () => {
    mocks.prisma.promoCode.findUnique.mockResolvedValue(PROMO_CODE);
    const res = await GET(
      req(`${BASE_URL}?from=2026-07-31&to=2026-07-01`),
      params("pc-1"),
    );
    expect(res.status).toBe(400);
    expect(mocks.prisma.promoCode.findUnique).not.toHaveBeenCalled();
  });

  it("paginates with skip/take derived from page and pageSize", async () => {
    seedHappyPath();
    const res = await GET(
      req(`${BASE_URL}?page=3&pageSize=25`),
      params("pc-1"),
    );
    expect(res.status).toBe(200);
    const rowsCall = mocks.prisma.promoRedemption.findMany.mock.calls[1][0];
    expect(rowsCall.skip).toBe(50);
    expect(rowsCall.take).toBe(25);
    const body = await res.json();
    expect(body.pagination.page).toBe(3);
    expect(body.pagination.pageSize).toBe(25);
  });

  it("retrieves redemptions for an archived, internal code", async () => {
    seedHappyPath({ archivedAt: new Date("2026-06-01T00:00:00.000Z"), internal: true });
    const res = await GET(req(BASE_URL), params("pc-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.code.archived).toBe(true);
    expect(body.code.internal).toBe(true);
  });
});
