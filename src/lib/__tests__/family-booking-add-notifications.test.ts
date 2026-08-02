import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/booking-guests", () => ({
  computeMemberGuestBoundary: vi.fn(),
}));
vi.mock("@/lib/email/family-booking", () => ({
  sendFamilyMemberBookingAddedEmail: vi.fn().mockResolvedValue({ status: "sent" }),
}));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/member-guest-delegate", () => ({
  familyAdultDelegateResolver: { resolveNotificationRecipients: vi.fn() },
}));

import { computeMemberGuestBoundary } from "@/lib/booking-guests";
import { sendFamilyMemberBookingAddedEmail } from "@/lib/email/family-booking";
import { logAudit } from "@/lib/audit";
import { sendFamilyMemberBookingAddNotifications } from "@/lib/family-booking-add-notifications";

const BOOKER = "booker";
const ACTOR = "booker"; // self-booking by default

function boundary(scopes: Record<string, "FAMILY" | "BEYOND_FAMILY">) {
  const scopeByMemberId = new Map(Object.entries(scopes));
  return {
    scopeByMemberId,
    beyondFamilyMemberIds: Object.entries(scopes)
      .filter(([, scope]) => scope === "BEYOND_FAMILY")
      .map(([id]) => id),
  };
}

function makeDb(overrides: Record<string, unknown> = {}) {
  return {
    booking: {
      findUnique: vi.fn().mockResolvedValue({
        id: "b1",
        checkIn: new Date("2099-01-01T00:00:00.000Z"),
        checkOut: new Date("2099-01-03T00:00:00.000Z"),
        lodgeId: "lodge-1",
        member: { firstName: "Bob", lastName: "Booker" },
      }),
    },
    member: {
      findMany: vi.fn().mockResolvedValue([
        { id: "child", firstName: "Cara", lastName: "Kid" },
      ]),
    },
    notificationPreference: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  };
}

function resolverReturning(
  recipients: Array<{
    memberId: string;
    email: string;
    firstName: string;
    isTarget: boolean;
  }>,
) {
  return {
    resolveNotificationRecipients: vi.fn().mockResolvedValue(recipients),
    canRespondForTarget: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(sendFamilyMemberBookingAddedEmail).mockResolvedValue({
    status: "sent",
  } as never);
});

describe("sendFamilyMemberBookingAddNotifications (#2284 S2)", () => {
  it("emails a login-holding family member directly (audience TARGET)", async () => {
    vi.mocked(computeMemberGuestBoundary).mockResolvedValue(
      boundary({ child: "FAMILY" }) as never,
    );
    const resolver = resolverReturning([
      { memberId: "child", email: "cara@example.test", firstName: "Cara", isTarget: true },
    ]);
    const db = makeDb();

    const result = await sendFamilyMemberBookingAddNotifications({
      bookingId: "b1",
      bookerMemberId: BOOKER,
      actorMemberId: ACTOR,
      addedMemberIds: ["child"],
      db: db as never,
      delegateResolver: resolver,
    });

    expect(sendFamilyMemberBookingAddedEmail).toHaveBeenCalledTimes(1);
    expect(sendFamilyMemberBookingAddedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: "b1",
        email: "cara@example.test",
        recipient: { kind: "member", memberId: "child" },
        audience: { kind: "TARGET" },
      }),
    );
    expect(result.notifiedTargetMemberIds).toEqual(["child"]);
  });

  it("tells the group's login-holding adults for a non-login member (audience DELEGATE)", async () => {
    vi.mocked(computeMemberGuestBoundary).mockResolvedValue(
      boundary({ child: "FAMILY" }) as never,
    );
    const resolver = resolverReturning([
      { memberId: "adultB", email: "b@example.test", firstName: "Bea", isTarget: false },
    ]);
    const db = makeDb();

    await sendFamilyMemberBookingAddNotifications({
      bookingId: "b1",
      bookerMemberId: BOOKER,
      actorMemberId: ACTOR,
      addedMemberIds: ["child"],
      db: db as never,
      delegateResolver: resolver,
    });

    expect(sendFamilyMemberBookingAddedEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "b@example.test",
        audience: { kind: "DELEGATE", addedMemberName: "Cara Kid" },
      }),
    );
  });

  it("does NOT notify a BEYOND_FAMILY add — that is the member-guest flow's job", async () => {
    // Mutation guard on the family-scope filter.
    vi.mocked(computeMemberGuestBoundary).mockResolvedValue(
      boundary({ stranger: "BEYOND_FAMILY" }) as never,
    );
    const resolver = resolverReturning([
      { memberId: "stranger", email: "s@example.test", firstName: "Sam", isTarget: true },
    ]);

    const result = await sendFamilyMemberBookingAddNotifications({
      bookingId: "b1",
      bookerMemberId: BOOKER,
      actorMemberId: ACTOR,
      addedMemberIds: ["stranger"],
      db: makeDb() as never,
      delegateResolver: resolver,
    });

    expect(sendFamilyMemberBookingAddedEmail).not.toHaveBeenCalled();
    expect(result.notifiedTargetMemberIds).toEqual([]);
  });

  it("honours the personal opt-out", async () => {
    vi.mocked(computeMemberGuestBoundary).mockResolvedValue(
      boundary({ child: "FAMILY" }) as never,
    );
    const resolver = resolverReturning([
      { memberId: "adultB", email: "b@example.test", firstName: "Bea", isTarget: false },
    ]);
    const db = makeDb({
      notificationPreference: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ memberId: "adultB", bookingAddedByFamily: false }]),
      },
    });

    const result = await sendFamilyMemberBookingAddNotifications({
      bookingId: "b1",
      bookerMemberId: BOOKER,
      actorMemberId: ACTOR,
      addedMemberIds: ["child"],
      db: db as never,
      delegateResolver: resolver,
    });

    expect(sendFamilyMemberBookingAddedEmail).not.toHaveBeenCalled();
    expect(result.suppressedByPreferenceMemberIds).toEqual(["adultB"]);
  });

  it("never tells the actor or the booking owner (they already know)", async () => {
    vi.mocked(computeMemberGuestBoundary).mockResolvedValue(
      boundary({ child: "FAMILY" }) as never,
    );
    const resolver = resolverReturning([
      { memberId: ACTOR, email: "actor@example.test", firstName: "Act", isTarget: false },
      { memberId: BOOKER, email: "booker@example.test", firstName: "Bob", isTarget: false },
      { memberId: "adultC", email: "c@example.test", firstName: "Cy", isTarget: false },
    ]);
    // An admin books on someone's behalf so actor != booker are distinct people.
    const result = await sendFamilyMemberBookingAddNotifications({
      bookingId: "b1",
      bookerMemberId: "owner",
      actorMemberId: "admin",
      addedMemberIds: ["child"],
      db: makeDb() as never,
      delegateResolver: resolverReturning([
        { memberId: "admin", email: "admin@example.test", firstName: "Ada", isTarget: false },
        { memberId: "owner", email: "owner@example.test", firstName: "Ove", isTarget: false },
        { memberId: "adultC", email: "c@example.test", firstName: "Cy", isTarget: false },
      ]),
    });

    expect(sendFamilyMemberBookingAddedEmail).toHaveBeenCalledTimes(1);
    expect(sendFamilyMemberBookingAddedEmail).toHaveBeenCalledWith(
      expect.objectContaining({ email: "c@example.test" }),
    );
    void resolver;
    expect(result.notifiedTargetMemberIds).toEqual(["child"]);
  });

  it("records an audit row and no send when nobody can be told", async () => {
    vi.mocked(computeMemberGuestBoundary).mockResolvedValue(
      boundary({ child: "FAMILY" }) as never,
    );
    // Only the actor resolves — after excluding them, nobody is left.
    const resolver = resolverReturning([
      { memberId: ACTOR, email: "actor@example.test", firstName: "Act", isTarget: false },
    ]);

    const result = await sendFamilyMemberBookingAddNotifications({
      bookingId: "b1",
      bookerMemberId: BOOKER,
      actorMemberId: ACTOR,
      addedMemberIds: ["child"],
      db: makeDb() as never,
      delegateResolver: resolver,
    });

    expect(sendFamilyMemberBookingAddedEmail).not.toHaveBeenCalled();
    expect(result.unreachableTargetMemberIds).toEqual(["child"]);
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.family_add.notification_unreachable",
        subjectMemberId: "child",
      }),
    );
  });

  it("skips the booker's own self-add without any reads", async () => {
    const result = await sendFamilyMemberBookingAddNotifications({
      bookingId: "b1",
      bookerMemberId: BOOKER,
      actorMemberId: ACTOR,
      addedMemberIds: [BOOKER],
      db: makeDb() as never,
      delegateResolver: resolverReturning([]),
    });

    expect(computeMemberGuestBoundary).not.toHaveBeenCalled();
    expect(sendFamilyMemberBookingAddedEmail).not.toHaveBeenCalled();
    expect(result.notifiedTargetMemberIds).toEqual([]);
  });
});
