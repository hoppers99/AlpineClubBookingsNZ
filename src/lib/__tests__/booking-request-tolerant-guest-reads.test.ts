/**
 * Tolerant admin READS of a stored booking-request guest list (#2342).
 *
 * The bug: the admin Booking Requests queue's **All** filter widened the query
 * past the default QUEUE statuses and pulled in a historical CONVERTED school
 * request whose stored guests carried `lastName: ""`. The serialiser parsed
 * every row strictly, the empty surname failed `nameField`, the parse threw,
 * and the WHOLE page of results 500'd — one malformed row taking down the
 * entire view.
 *
 * The contract these tests pin:
 *   - a malformed row renders (flagged, names as stored) in the LIST payload
 *     and in the per-request DETAIL payload, instead of throwing;
 *   - a well-formed row's payload is unchanged, flag and all (there is no flag);
 *   - WRITES still reject an empty name, and the strict reader every
 *     conversion/approval path uses still throws on a malformed stored row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { BookingRequest } from "@prisma/client";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    bookingRequest: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    bookingRequestQuote: { findMany: vi.fn().mockResolvedValue([]) },
    member: { findMany: vi.fn().mockResolvedValue([]) },
    lodge: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    $transaction: vi.fn(),
  },
}));

// Import-graph trims: the serialiser under test is pure, but it lives in the
// module that also owns the create/approve/decline pipeline.
vi.mock("@/lib/email", () => ({
  sendBookingRequestVerificationEmail: vi.fn(),
  sendAdminBookingRequestPendingEmail: vi.fn(),
  sendBookingRequestApprovedEmail: vi.fn(),
  sendBookingRequestDeclinedEmail: vi.fn(),
  sendAdminOwnerSubstitutionAlert: vi.fn(),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/booking-cancel", () => ({ cancelBooking: vi.fn() }));
vi.mock("@/lib/capacity", () => ({
  acquireLodgeCapacityLock: vi.fn(),
  checkCapacityForGuestRanges: vi.fn(),
}));
vi.mock("@/lib/lodge-capacity", () => ({
  getLodgeCapacity: vi.fn().mockResolvedValue(20),
  getDefaultLodgeCapacity: vi.fn().mockResolvedValue(20),
}));
vi.mock("@/lib/lodge-settings", () => ({
  loadSchoolGroupSoftCap: vi.fn().mockResolvedValue(25),
}));
vi.mock("@/lib/cancellation", () => ({ getNonMemberHoldDays: vi.fn().mockResolvedValue(2) }));
vi.mock("@/lib/logger", () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/booking-request-quotes", () => ({
  parseBookingRequestQuoteOptions: vi.fn(() => []),
}));

const guards = vi.hoisted(() => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/session-guards", () => ({ requireAdmin: guards.requireAdmin }));

const limits = vi.hoisted(() => ({ applyRateLimit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  applyRateLimit: limits.applyRateLimit,
  getClientIp: () => "127.0.0.1",
  rateLimiters: { bookingRequest: { id: "booking-request", limit: 5, windowSeconds: 3600 } },
}));

import {
  bookingRequestGuestSchema,
  parseBookingRequestGuests,
  readBookingRequestGuestsForDisplay,
  serializeBookingRequestForAdmin,
} from "@/lib/booking-request";
import { prisma } from "@/lib/prisma";
import { GET as listRequests } from "@/app/api/admin/booking-requests/route";
import { POST as priceRequest } from "@/app/api/admin/booking-requests/[id]/price/route";
import { POST as submitPublicRequest } from "@/app/api/booking-requests/route";

const db = prisma as unknown as {
  bookingRequest: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

const HEALTHY_GUESTS = [
  { firstName: "Tina", lastName: "Tramper", ageTier: "ADULT" },
  { firstName: "Theo", lastName: "Tramper", ageTier: "CHILD" },
];

/**
 * The exact stored shape that produced the 500: the pre-#2342 demo seed's
 * CONVERTED school request, whose children carried an empty surname.
 */
const MALFORMED_GUESTS = [
  { firstName: "Mr", lastName: "Teacher", ageTier: "ADULT" },
  { firstName: "School Child 1", lastName: "", ageTier: "YOUTH" },
  { firstName: "School Child 2", lastName: "", ageTier: "YOUTH" },
];

function row(overrides: Record<string, unknown> = {}): BookingRequest & {
  lodge?: { name: string } | null;
} {
  return {
    id: "req-good",
    type: "GENERAL",
    status: "VERIFIED",
    lodgeId: null,
    lodge: null,
    exclusivityRequested: false,
    requestedByMemberId: null,
    schoolName: null,
    teachers: null,
    cateringPreference: null,
    linkedGuestMembers: null,
    contactFirstName: "Tina",
    contactLastName: "Tramper",
    contactEmail: "tina@example.com",
    contactPhone: null,
    checkIn: new Date("2026-09-01T00:00:00.000Z"),
    checkOut: new Date("2026-09-03T00:00:00.000Z"),
    guests: HEALTHY_GUESTS,
    message: null,
    indicativePriceCents: null,
    priceCents: null,
    verifiedAt: null,
    pricedAt: null,
    pricedByMemberId: null,
    reviewedAt: null,
    reviewedByMemberId: null,
    declineReason: null,
    convertedBookingId: null,
    attendeesConfirmedAt: null,
    convertedMemberId: null,
    heldBookingId: null,
    acceptedQuoteId: null,
    acceptedQuoteOptionId: null,
    acceptedPriceCents: null,
    acceptedAt: null,
    responseMessage: null,
    responseMessageAt: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    ...overrides,
  } as unknown as BookingRequest & { lodge?: { name: string } | null };
}

const badRow = () =>
  row({ id: "req-bad", type: "SCHOOL", status: "CONVERTED", guests: MALFORMED_GUESTS });

beforeEach(() => {
  vi.clearAllMocks();
  guards.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  limits.applyRateLimit.mockResolvedValue(null);
});

describe("readBookingRequestGuestsForDisplay (#2342)", () => {
  it("returns a well-formed list exactly as the strict reader does, unflagged", () => {
    const display = readBookingRequestGuestsForDisplay(HEALTHY_GUESTS);

    expect(display.needsAttention).toBe(false);
    expect(display.guests).toEqual(parseBookingRequestGuests(HEALTHY_GUESTS));
  });

  it("keeps the stored names and flags the row when the list fails the schema", () => {
    const display = readBookingRequestGuestsForDisplay(MALFORMED_GUESTS);

    expect(display.needsAttention).toBe(true);
    expect(display.guests).toEqual([
      { firstName: "Mr", lastName: "Teacher", ageTier: "ADULT" },
      { firstName: "School Child 1", lastName: "", ageTier: "YOUTH" },
      { firstName: "School Child 2", lastName: "", ageTier: "YOUTH" },
    ]);
  });

  it("flags — and never throws on — stored JSON that is not a guest list at all", () => {
    expect(readBookingRequestGuestsForDisplay(null)).toEqual({
      guests: [],
      needsAttention: true,
    });
    expect(readBookingRequestGuestsForDisplay({ nope: true })).toEqual({
      guests: [],
      needsAttention: true,
    });
    // Non-string cells have no sensible rendering, so they become empty cells
    // rather than "[object Object]" — but the row still renders.
    expect(
      readBookingRequestGuestsForDisplay([{ firstName: 7, lastName: null, ageTier: {} }]),
    ).toEqual({
      guests: [{ firstName: "", lastName: "", ageTier: "" }],
      needsAttention: true,
    });
  });

  it("strips CR/LF from salvaged names, which bypassed nameField's strip", () => {
    const display = readBookingRequestGuestsForDisplay([
      { firstName: "Eve\r\nBcc: attacker@example.com", lastName: "", ageTier: "ADULT" },
    ]);

    expect(display.needsAttention).toBe(true);
    expect(display.guests[0].firstName).toBe("Eve Bcc: attacker@example.com");
  });
});

describe("serializeBookingRequestForAdmin (#2342)", () => {
  it("leaves a well-formed row's payload untouched and adds no flag", () => {
    const serialized = serializeBookingRequestForAdmin(row());

    expect(serialized.guests).toEqual(HEALTHY_GUESTS);
    expect("guestDataNeedsAttention" in serialized).toBe(false);
  });

  it("flags — and does not throw on — an unreadable linked-member list", () => {
    // The other stored JSON blob this payload parses, and the other way one bad
    // row could 500 the queue. It falls back to NO links: a guest index or
    // member id we cannot trust is worse than none.
    const serialized = serializeBookingRequestForAdmin(
      row({ linkedGuestMembers: [{ guestIndex: -1, memberId: "" }] }),
    );

    expect(serialized).toMatchObject({ guestDataNeedsAttention: true });
    expect(serialized.linkedGuestMembers).toEqual([]);
    // The guest list itself was fine, so it is still served in full.
    expect(serialized.guests).toEqual(HEALTHY_GUESTS);
  });

  it("still serialises a well-formed linked-member list unflagged", () => {
    const serialized = serializeBookingRequestForAdmin(
      row({ linkedGuestMembers: [{ guestIndex: 0, memberId: "mem-1" }] }),
    );

    expect("guestDataNeedsAttention" in serialized).toBe(false);
    expect(serialized.linkedGuestMembers).toEqual([
      { guestIndex: 0, memberId: "mem-1" },
    ]);
  });

  it("serialises a malformed row instead of throwing", () => {
    const serialized = serializeBookingRequestForAdmin(badRow());

    expect(serialized).toMatchObject({ id: "req-bad", guestDataNeedsAttention: true });
    expect(serialized.guests).toHaveLength(3);
    expect(serialized.guests[1]).toEqual({
      firstName: "School Child 1",
      lastName: "",
      ageTier: "YOUTH",
    });
  });
});

describe("GET /api/admin/booking-requests — the list path (#2342)", () => {
  it("returns 200 for status=ALL with a malformed row on the page, flagging only that row", async () => {
    db.bookingRequest.findMany.mockResolvedValue([row(), badRow()]);
    db.bookingRequest.count.mockResolvedValue(2);

    const res = await listRequests(
      new NextRequest("http://localhost/api/admin/booking-requests?status=ALL"),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ id: string; guestDataNeedsAttention?: boolean; guests: unknown[] }>;
    };
    // The whole page survives: the good row is still there, unflagged.
    expect(body.data).toHaveLength(2);
    expect(body.data[0]).toMatchObject({ id: "req-good" });
    expect(body.data[0].guestDataNeedsAttention).toBeUndefined();
    expect(body.data[1]).toMatchObject({ id: "req-bad", guestDataNeedsAttention: true });
    expect(body.data[1].guests).toHaveLength(3);
    // status=ALL is the filter that surfaced the bug: it must widen past QUEUE.
    expect(db.bookingRequest.findMany.mock.calls[0][0].where).toBeUndefined();
  });
});

describe("POST /api/admin/booking-requests/[id]/price — the detail path (#2342)", () => {
  it("returns the per-request payload for a malformed row with the attention flag", async () => {
    db.bookingRequest.findUnique.mockResolvedValue(badRow());
    db.bookingRequest.updateMany.mockResolvedValue({ count: 1 });

    const res = await priceRequest(
      new NextRequest("http://localhost/api/admin/booking-requests/req-bad/price", {
        method: "POST",
        body: JSON.stringify({ priceCents: 36000 }),
        headers: { "content-type": "application/json" },
      }),
      { params: Promise.resolve({ id: "req-bad" }) },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      guestDataNeedsAttention?: boolean;
      guests: unknown[];
    };
    expect(body).toMatchObject({ id: "req-bad", guestDataNeedsAttention: true });
    expect(body.guests).toHaveLength(3);
  });
});

describe("writes and conversions stay strict (#2342)", () => {
  it("rejects an empty surname at the guest schema", () => {
    const parsed = bookingRequestGuestSchema.safeParse({
      firstName: "School Child 1",
      lastName: "",
      ageTier: "YOUTH",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects an empty surname on the public submission route with 422", async () => {
    const res = await submitPublicRequest(
      new NextRequest("http://localhost/api/booking-requests", {
        method: "POST",
        body: JSON.stringify({
          contactFirstName: "Mr",
          contactLastName: "Teacher",
          contactEmail: "office@example.com",
          checkIn: "2099-09-01",
          checkOut: "2099-09-03",
          guests: MALFORMED_GUESTS,
        }),
        headers: { "content-type": "application/json" },
      }),
    );

    expect(res.status).toBe(422);
  });

  it("still throws from the strict reader the conversion/approval paths use", () => {
    // approveBookingRequest, the school approval, and every quote/pricing path
    // read through this function. A row the admin queue merely DISPLAYS must
    // never become booking guests.
    expect(() => parseBookingRequestGuests(MALFORMED_GUESTS)).toThrowError(
      /Stored booking request guests are invalid/,
    );
  });
});
