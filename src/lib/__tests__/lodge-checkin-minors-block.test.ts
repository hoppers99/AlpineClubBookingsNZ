import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdminReviewStatus } from "@prisma/client";
import { ADULT_SUPERVISION_REVIEW_REASON } from "@/lib/booking-review";

// F27 / #1372: every lodge check-in surface must exclude a paid booking that is
// blocked by a pending minors-only (no-adult) review. These tests prove the
// shared where-fragment reaches each query (guest list, arrive/depart, roster
// generate/confirm), and that the admin alert sender is wired to sendToAdmins.

const prismaMocks = vi.hoisted(() => ({
  bookingGuestFindFirst: vi.fn(),
  bookingGuestFindMany: vi.fn(),
  bookingFindMany: vi.fn(),
  choreTemplateFindMany: vi.fn(),
  choreAssignmentFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingGuest: {
      findFirst: prismaMocks.bookingGuestFindFirst,
      findMany: prismaMocks.bookingGuestFindMany,
    },
    booking: { findMany: prismaMocks.bookingFindMany },
    choreTemplate: { findMany: prismaMocks.choreTemplateFindMany },
    choreAssignment: { findMany: prismaMocks.choreAssignmentFindMany },
  },
}));

const lodgeAuthMocks = vi.hoisted(() => ({ checkLodgeAuth: vi.fn() }));
vi.mock("@/lib/lodge-auth", () => ({
  checkLodgeAuth: lodgeAuthMocks.checkLodgeAuth,
  getLodgeAuthActorMemberId: vi.fn(() => "actor-1"),
}));

vi.mock("@/lib/logger", () => ({
  default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Spy on the shared fan-out so the sender test asserts the exact envelope
// (subject / templateName / preferenceKey) without a live email stack.
const sharedMocks = vi.hoisted(() => ({ sendToAdmins: vi.fn() }));
vi.mock("@/lib/email/admin-alerts-shared", () => ({
  sendToAdmins: sharedMocks.sendToAdmins,
  getAdminEmails: vi.fn(),
}));

import {
  findLodgeGuestForDate,
  findLodgeGuestDepartingOnDate,
  validateRosterAllocationsForDate,
} from "@/lib/lodge-date-scoping";
import { routeParams } from "@/lib/__tests__/helpers/requests";

const BLOCK_FRAGMENT = {
  requiresAdminReview: true,
  adminReviewStatus: AdminReviewStatus.PENDING,
  adminReviewReason: ADULT_SUPERVISION_REVIEW_REASON,
};

function dateOnly(y: number, m: number, d: number) {
  return new Date(y, m, d);
}

describe("lodge check-in blocks a pending minors-only review (#1372)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lodgeAuthMocks.checkLodgeAuth.mockResolvedValue({ tier: "lodge" });
  });

  it("arrive lookup (findLodgeGuestForDate) excludes the blocked booking", async () => {
    prismaMocks.bookingGuestFindFirst.mockResolvedValueOnce(null);

    await findLodgeGuestForDate("guest-1", dateOnly(2026, 6, 10));

    expect(prismaMocks.bookingGuestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: expect.objectContaining({ NOT: BLOCK_FRAGMENT }),
        }),
      }),
    );
  });

  it("depart lookup (findLodgeGuestDepartingOnDate) excludes the blocked booking", async () => {
    prismaMocks.bookingGuestFindFirst.mockResolvedValueOnce(null);

    await findLodgeGuestDepartingOnDate("guest-1", dateOnly(2026, 6, 12));

    expect(prismaMocks.bookingGuestFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: expect.objectContaining({ NOT: BLOCK_FRAGMENT }),
        }),
      }),
    );
  });

  it("roster confirm validation (validateRosterAllocationsForDate) excludes the blocked booking", async () => {
    prismaMocks.bookingGuestFindMany.mockResolvedValueOnce([]);

    await validateRosterAllocationsForDate(
      [{ bookingGuestId: "guest-1", bookingId: "booking-1" }],
      dateOnly(2026, 6, 10),
    );

    expect(prismaMocks.bookingGuestFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          booking: expect.objectContaining({ NOT: BLOCK_FRAGMENT }),
        }),
      }),
    );
  });

  it("lodge guest list query excludes the blocked booking", async () => {
    prismaMocks.bookingFindMany.mockResolvedValueOnce([]);
    const { GET } = await import("@/app/api/lodge/guests/[date]/route");

    const res = await GET(
      new Request("http://localhost/api/lodge/guests/2026-07-10") as never,
      routeParams({ date: "2026-07-10" }),
    );

    expect(res.status).toBe(200);
    expect(prismaMocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ NOT: BLOCK_FRAGMENT }),
      }),
    );
  });

  it("roster generate query excludes the blocked booking", async () => {
    lodgeAuthMocks.checkLodgeAuth.mockResolvedValue({ tier: "hut-leader" });
    prismaMocks.bookingFindMany.mockResolvedValueOnce([]);
    prismaMocks.choreTemplateFindMany.mockResolvedValueOnce([]);
    prismaMocks.choreAssignmentFindMany.mockResolvedValueOnce([]);
    const { POST } = await import("@/app/api/lodge/roster/[date]/generate/route");

    const res = await POST(
      new Request("http://localhost/api/lodge/roster/2026-07-10/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ choreTemplateIds: ["chore-1"] }),
      }) as never,
      routeParams({ date: "2026-07-10" }),
    );

    expect(res.status).toBe(200);
    expect(prismaMocks.bookingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ NOT: BLOCK_FRAGMENT }),
      }),
    );
  });
});

describe("sendAdminMinorsOnlyReviewAlert (#1372)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("alerts opted-in admins with a minors-only subject and template", async () => {
    sharedMocks.sendToAdmins.mockResolvedValueOnce(undefined);
    const { sendAdminMinorsOnlyReviewAlert } = await import(
      "@/lib/email/admin-alerts-booking"
    );

    await sendAdminMinorsOnlyReviewAlert({
      memberName: "Alex Parent",
      checkIn: dateOnly(2026, 6, 10),
      checkOut: dateOnly(2026, 6, 12),
      guestCount: 2,
      reviewReason: ADULT_SUPERVISION_REVIEW_REASON,
    });

    expect(sharedMocks.sendToAdmins).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: expect.stringContaining("only under-18 guests"),
        templateName: "admin-minors-review",
        // Recipients are the admins opted into the "New bookings / review
        // required" category (reused per the owner's decision).
        preferenceKey: "adminNewBooking",
        templateData: expect.objectContaining({
          memberName: "Alex Parent",
          guestCount: 2,
          reviewReason: ADULT_SUPERVISION_REVIEW_REASON,
        }),
      }),
    );
  });
});
