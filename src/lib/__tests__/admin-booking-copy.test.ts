import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  createDraftBooking: vi.fn(),
  logAudit: vi.fn(),
  resolveLinkedBookingMembers: vi.fn(),
  resolveLinkedBookingMembersWithBoundary: vi.fn(),
  assertLinkedBookingMembersCanBeBooked: vi.fn(),
  normalizeBookingGuestInputs: vi.fn(),
  sendMemberGuestAddNotifications: vi.fn().mockResolvedValue({
    sentGuestIds: [],
    failedGuestIds: [],
    unreachableGuestIds: [],
  }),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    member: { findMany: vi.fn() },
    familyGroupMember: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/booking-create", () => ({
  createDraftBooking: mocks.createDraftBooking,
}));

vi.mock("@/lib/booking-guests", () => ({
  BookingGuestValidationError: class BookingGuestValidationError extends Error {
    constructor(
      message: string,
      public status: number,
    ) {
      super(message);
    }
  },
  // MG3 (#2308) C1: `markCrossFamilyGuestsOnBooking` re-derives the D-8 marker
  // over the WHOLE proposed party from this function. These fixtures are about
  // pricing/payment rather than family boundaries, and were written when every
  // member-linked guest in them was family scope, so an empty boundary states
  // that assumption explicitly. The C1 behaviour itself is covered by
  // `member-guest-cross-family-refusals.test.ts` and by the source contract in
  // `review-findings-contracts.test.ts`.
  computeMemberGuestBoundary: vi.fn().mockResolvedValue({
    scopeByMemberId: new Map(),
    beyondFamilyMemberIds: [],
  }),
  resolveLinkedBookingMembers: mocks.resolveLinkedBookingMembers,
  resolveLinkedBookingMembersWithBoundary:
    mocks.resolveLinkedBookingMembersWithBoundary,
  assertLinkedBookingMembersCanBeBooked:
    mocks.assertLinkedBookingMembersCanBeBooked,
  normalizeBookingGuestInputs: mocks.normalizeBookingGuestInputs,
}));

vi.mock("@/lib/audit", () => ({
  logAudit: mocks.logAudit,
}));

// MG4 (#2309): the copy's consent decision needs the module ON to do anything at
// all — with it off `planMemberGuestConsentWrites` returns the guests untouched,
// which is MG1's behaviour and is asserted separately. Turning it on here is
// what makes the four-state matrix below a real test of the copy's re-stamp
// rather than a test of the module flag.
vi.mock("@/lib/admin-modules", () => ({
  isEffectiveModuleEnabled: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/member-guest-settings", () => ({
  loadMemberGuestSettings: vi.fn().mockResolvedValue({
    approvalRequired: true,
    pendingHoldExpiryDays: 7,
    openMemberSearchEnabled: false,
    openMemberSearchIncludesMinors: false,
  }),
}));
// The post-commit notifier is loaded lazily by the copy; stub it so the matrix
// exercises the COLUMNS without dragging the whole email graph in.
vi.mock("@/lib/member-guest-consent-notifications", () => ({
  sendMemberGuestAddNotifications: mocks.sendMemberGuestAddNotifications,
}));

import { copyBookingToDraft } from "@/lib/admin-booking-copy";
import { classifyMemberGuestConsent } from "@/lib/member-guest-consent";

function makeSourceBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: "source-booking",
    memberId: "member-1",
    checkIn: new Date("2026-08-01T00:00:00.000Z"),
    checkOut: new Date("2026-08-04T00:00:00.000Z"),
    deletedAt: null,
    notes: "Late arrival",
    expectedArrivalTime: "19:00",
    member: { id: "member-1", active: true },
    guests: [
      {
        id: "guest-1",
        firstName: "Nina",
        lastName: "Visitor",
        ageTier: "ADULT",
        isMember: false,
        memberId: null,
        stayStart: new Date("2026-08-01T00:00:00.000Z"),
        stayEnd: new Date("2026-08-03T00:00:00.000Z"),
      },
      {
        id: "guest-2",
        firstName: "Old",
        lastName: "Member",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-2",
        stayStart: new Date("2026-08-02T00:00:00.000Z"),
        stayEnd: new Date("2026-08-04T00:00:00.000Z"),
      },
    ],
    ...overrides,
  };
}

describe("copyBookingToDraft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveLinkedBookingMembers.mockResolvedValue(
      new Map([
        [
          "member-2",
          {
            id: "member-2",
            firstName: "Current",
            lastName: "Member",
            ageTier: "YOUTH",
          },
        ],
      ]),
    );
    // MG2 (#2307): the copy uses the boundary-returning resolver so it can decide
    // each guest's consent. An empty boundary is "everybody is inside the booking
    // owner's family", which is this test's world unchanged.
    mocks.resolveLinkedBookingMembersWithBoundary.mockImplementation(
      async (...args: unknown[]) => ({
        members: await mocks.resolveLinkedBookingMembers(...args),
        boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
      }),
    );
    mocks.assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
    mocks.normalizeBookingGuestInputs.mockImplementation((guests, linkedMembers) =>
      guests.map((guest: any) => {
        const linkedMember = guest.memberId
          ? linkedMembers.get(guest.memberId)
          : null;
        return linkedMember
          ? {
              ...guest,
              firstName: linkedMember.firstName,
              lastName: linkedMember.lastName,
              ageTier: linkedMember.ageTier,
              isMember: true,
            }
          : guest;
      }),
    );
    mocks.createDraftBooking.mockResolvedValue({
      id: "draft-copy",
      status: "DRAFT",
    });
  });

  it("creates a draft copy with shifted guest ranges and recalculated creation input", async () => {
    mocks.bookingFindUnique.mockResolvedValue(makeSourceBooking());

    const result = await copyBookingToDraft({
      sourceBookingId: "source-booking",
      targetCheckIn: "2026-09-10",
      adminMemberId: "admin-1",
    });

    expect(result).toEqual({
      bookingId: "draft-copy",
      sourceBookingId: "source-booking",
      checkIn: "2026-09-10",
      checkOut: "2026-09-13",
      status: "DRAFT",
    });
    expect(mocks.createDraftBooking).toHaveBeenCalledWith(
      expect.objectContaining({
        effectiveMemberId: "member-1",
        isOnBehalf: true,
        sessionUserId: "admin-1",
        checkIn: new Date("2026-09-10T00:00:00.000Z"),
        checkOut: new Date("2026-09-13T00:00:00.000Z"),
        notes: "Late arrival",
        expectedArrivalTime: "19:00",
      }),
    );
    const call = mocks.createDraftBooking.mock.calls[0][0];
    expect(call.guests).toEqual([
      expect.objectContaining({
        firstName: "Nina",
        lastName: "Visitor",
        ageTier: "ADULT",
        isMember: false,
        memberId: undefined,
        stayStart: new Date("2026-09-10T00:00:00.000Z"),
        stayEnd: new Date("2026-09-12T00:00:00.000Z"),
      }),
      expect.objectContaining({
        firstName: "Current",
        lastName: "Member",
        ageTier: "YOUTH",
        isMember: true,
        memberId: "member-2",
        stayStart: new Date("2026-09-11T00:00:00.000Z"),
        stayEnd: new Date("2026-09-13T00:00:00.000Z"),
      }),
    ]);
    expect(mocks.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.copy.created",
        memberId: "admin-1",
        targetId: "draft-copy",
        metadata: expect.objectContaining({
          sourceBookingId: "source-booking",
          copiedBookingId: "draft-copy",
        }),
      }),
    );
  });

  it("rejects deleted source bookings", async () => {
    mocks.bookingFindUnique.mockResolvedValue(
      makeSourceBooking({ deletedAt: new Date("2026-08-10T00:00:00.000Z") }),
    );

    await expect(
      copyBookingToDraft({
        sourceBookingId: "source-booking",
        targetCheckIn: "2026-09-10",
        adminMemberId: "admin-1",
      }),
    ).rejects.toMatchObject({
      message: "Deleted bookings cannot be copied",
      status: 400,
    });
    expect(mocks.createDraftBooking).not.toHaveBeenCalled();
  });
});

/**
 * MG4 (#2309): the copy's consent-column matrix, mandatory per §5.4.
 *
 * A copy is where consent is most likely to be inherited by accident: the
 * source row already has columns, and the obvious implementation copies them
 * with everything else. That would mean a member who DECLINED, or one whose
 * request LAPSED, silently arriving CONFIRMED on a second booking they were
 * never asked about — the exact gap this epic exists to close, reintroduced by
 * the one path that skips authorization unconditionally.
 *
 * So all four source states are walked, and all four must produce the SAME
 * answer: consent is not transitive across bookings, and a copy is an admin act
 * (MG4-D-a), so a cross-family row is re-stamped ADMIN_ASSIGNED against the
 * COPYING admin and the target is notified. Family rows are untouched.
 */
describe("copyBookingToDraft — the consent-column matrix (MG4 #2309)", () => {
  const SOURCE_STATES = [
    {
      label: "PENDING",
      columns: {
        consentStatus: "PENDING",
        consentRequestedAt: new Date("2026-07-01T09:00:00.000Z"),
        consentRespondedAt: null,
        consentRespondedByMemberId: null,
        consentExpiresAt: new Date("2026-07-08T09:00:00.000Z"),
      },
    },
    {
      label: "CONFIRMED by the target themselves",
      columns: {
        consentStatus: "CONFIRMED",
        consentRequestedAt: new Date("2026-07-01T09:00:00.000Z"),
        consentRespondedAt: new Date("2026-07-02T09:00:00.000Z"),
        consentRespondedByMemberId: "member-2",
        consentExpiresAt: null,
      },
    },
    {
      label: "DECLINED",
      columns: {
        consentStatus: "DECLINED",
        consentRequestedAt: new Date("2026-07-01T09:00:00.000Z"),
        consentRespondedAt: new Date("2026-07-02T09:00:00.000Z"),
        consentRespondedByMemberId: "member-2",
        consentExpiresAt: null,
      },
    },
    {
      label: "EXPIRED",
      columns: {
        consentStatus: "EXPIRED",
        consentRequestedAt: new Date("2026-07-01T09:00:00.000Z"),
        consentRespondedAt: null,
        consentRespondedByMemberId: null,
        consentExpiresAt: new Date("2026-07-08T09:00:00.000Z"),
      },
    },
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveLinkedBookingMembers.mockResolvedValue(
      new Map([
        [
          "member-2",
          {
            id: "member-2",
            firstName: "Current",
            lastName: "Member",
            ageTier: "YOUTH",
          },
        ],
      ]),
    );
    mocks.resolveLinkedBookingMembersWithBoundary.mockImplementation(
      async (...args: unknown[]) => ({
        members: await mocks.resolveLinkedBookingMembers(...args),
        boundary: { scopeByMemberId: new Map(), beyondFamilyMemberIds: [] },
      }),
    );
    mocks.assertLinkedBookingMembersCanBeBooked.mockResolvedValue(undefined);
    mocks.normalizeBookingGuestInputs.mockImplementation(
      (guests: any[], linkedMembers: Map<string, any>) =>
        guests.map((guest: any) => {
          const linkedMember = guest.memberId
            ? linkedMembers.get(guest.memberId)
            : null;
          return linkedMember
            ? {
                ...guest,
                firstName: linkedMember.firstName,
                lastName: linkedMember.lastName,
                ageTier: linkedMember.ageTier,
                isMember: true,
              }
            : guest;
        }),
    );
    // The created draft carries its rows back, which is how the copy matches its
    // notification plan to the ids that now exist.
    mocks.createDraftBooking.mockResolvedValue({
      id: "draft-copy",
      status: "DRAFT",
      guests: [
        { id: "copied-1", memberId: null },
        { id: "copied-2", memberId: "member-2" },
      ],
    });
  });

  function sourceWithConsent(columns: Record<string, unknown>) {
    const source = makeSourceBooking();
    source.guests[1] = { ...source.guests[1], ...columns } as never;
    return source;
  }

  /** The copy resolves member-2 as BEYOND the copying booking owner's family. */
  function crossFamilyBoundary() {
    mocks.resolveLinkedBookingMembersWithBoundary.mockImplementation(
      async (...args: unknown[]) => ({
        members: await mocks.resolveLinkedBookingMembers(...args),
        boundary: {
          scopeByMemberId: new Map([["member-2", "BEYOND_FAMILY"]]),
          beyondFamilyMemberIds: ["member-2"],
        },
      }),
    );
  }

  it.each(SOURCE_STATES)(
    "never lets a $label source row arrive on the copy carrying its old consent",
    async ({ columns }) => {
      crossFamilyBoundary();
      mocks.bookingFindUnique.mockResolvedValue(sourceWithConsent(columns));

      await copyBookingToDraft({
        sourceBookingId: "source-booking",
        targetCheckIn: "2026-09-10",
        adminMemberId: "admin-1",
      });

      const guests = mocks.createDraftBooking.mock.calls[0][0]
        .guests as Array<Record<string, unknown>>;
      const copied = guests.find((guest) => guest.memberId === "member-2");
      expect(copied).toBeTruthy();

      // Whatever the source said, the copy is the copying admin's own act:
      // ADMIN_ASSIGNED, naming the admin who pressed copy.
      expect(copied!.memberGuestConsent).toMatchObject({
        consentStatus: "CONFIRMED",
        consentRequestedAt: null,
        consentRespondedByMemberId: "admin-1",
        consentExpiresAt: null,
      });
      expect(
        classifyMemberGuestConsent(
          copied!.memberGuestConsent as never,
          "member-2",
        ),
      ).toBe("ADMIN_ASSIGNED");
      // ...and nothing of the source's own record survives onto it. The raw
      // columns are never spread on to the row alongside the planned ones.
      expect(copied).not.toHaveProperty("consentStatus");
      expect(
        (copied!.memberGuestConsent as { consentRespondedAt: Date })
          .consentRespondedAt,
      ).not.toEqual(columns.consentRespondedAt);
    },
  );

  it("leaves a family-scope guest with no consent record at all, whatever the source carried", async () => {
    // The boundary is empty here — member-2 is inside the copying owner's
    // family — so D-6 applies and no consent record should be minted. A copy
    // that stamped one anyway would be inventing a consent decision for a
    // household member nobody ever needed to ask.
    mocks.bookingFindUnique.mockResolvedValue(
      sourceWithConsent(SOURCE_STATES[1].columns),
    );

    await copyBookingToDraft({
      sourceBookingId: "source-booking",
      targetCheckIn: "2026-09-10",
      adminMemberId: "admin-1",
    });

    const guests = mocks.createDraftBooking.mock.calls[0][0]
      .guests as Array<Record<string, unknown>>;
    const copied = guests.find((guest) => guest.memberId === "member-2");
    expect(copied).not.toHaveProperty("consentStatus");
    expect(copied).not.toHaveProperty("memberGuestConsent");
  });

  it("never carries the source's consent columns onto a NON-member guest row", async () => {
    // The free-text guest has no member behind it, so nothing about consent can
    // apply to it. Asserted because the copy builds every row through one
    // mapping, and a stray spread would land on this one too.
    crossFamilyBoundary();
    mocks.bookingFindUnique.mockResolvedValue(
      sourceWithConsent(SOURCE_STATES[0].columns),
    );

    await copyBookingToDraft({
      sourceBookingId: "source-booking",
      targetCheckIn: "2026-09-10",
      adminMemberId: "admin-1",
    });

    const guests = mocks.createDraftBooking.mock.calls[0][0]
      .guests as Array<Record<string, unknown>>;
    const nonMember = guests.find((guest) => !guest.memberId);
    expect(nonMember).toBeTruthy();
    expect(nonMember).not.toHaveProperty("consentStatus");
    expect(nonMember).not.toHaveProperty("memberGuestConsent");
  });
});
