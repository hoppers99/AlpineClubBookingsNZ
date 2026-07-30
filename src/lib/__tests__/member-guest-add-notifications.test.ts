// "+ Add Member Guest" (epic #2305) MG2 (#2307) — the post-commit dispatcher.
//
// The dispatcher is where three separate promises are kept, and each one has its
// own tests below because each one fails silently if it is broken:
//
//  * D-9's recipient rule. A target with no login of their own is the NORMAL case,
//    not an edge case, so "email the member" is the wrong rule and a mail that
//    goes nowhere looks exactly like a mail that was sent.
//  * ISOLATION. A booking that has already been paid for must not be affected by
//    a mail failure, and one recipient's bad address must not stop the next.
//  * HONESTY WHEN THERE IS NOBODY TO TELL. A member with no login and no family
//    adult cannot be asked, and the request then holds a bed nobody will ever
//    answer for. That is a real state of a club's data, so it is logged AND
//    audited rather than swallowed or turned into a booking failure.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { sendMemberGuestAddNotifications } from "@/lib/member-guest-consent-notifications";
import type { MemberGuestConsentDelegateResolver } from "@/lib/member-guest-delegate";
import { parseDateOnly } from "@/lib/date-only";

const h = vi.hoisted(() => ({
  sendConsentRequest: vi.fn(),
  sendAdded: vi.fn(),
  logAudit: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/email/member-guest", () => ({
  sendMemberGuestConsentRequestEmail: h.sendConsentRequest,
  sendMemberGuestAddedEmail: h.sendAdded,
}));
vi.mock("@/lib/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: h.loggerError,
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

const BOOKING = "bk-1";
const GUEST_ROW = "bg-1";
const TARGET = "m-target";
const PARENT = "m-parent";
const OTHER_PARENT = "m-other-parent";
const ADMIN = "m-admin";

const CHECK_IN = parseDateOnly("2026-09-10");
const CHECK_OUT = parseDateOnly("2026-09-12");
const EXPIRES = new Date("2026-09-05T12:00:00.000Z");

function db(overrides?: { consentExpiresAt?: Date | null; nights?: Array<{ stayDate: Date }> }) {
  return {
    booking: {
      findUnique: vi.fn(async () => ({
        id: BOOKING,
        lodgeId: "lodge-1",
        checkIn: CHECK_IN,
        checkOut: CHECK_OUT,
        status: "CONFIRMED",
        memberId: "m-booker",
        member: { firstName: "Bev", lastName: "Booker" },
        guests: [
          {
            id: GUEST_ROW,
            firstName: "Tam",
            lastName: "Target",
            stayStart: CHECK_IN,
            stayEnd: CHECK_OUT,
            consentExpiresAt:
              overrides?.consentExpiresAt === undefined ? EXPIRES : overrides.consentExpiresAt,
            nights: overrides?.nights ?? [{ stayDate: CHECK_IN }],
          },
          {
            id: "bg-booker",
            firstName: "Bev",
            lastName: "Booker",
            stayStart: CHECK_IN,
            stayEnd: CHECK_OUT,
            consentExpiresAt: null,
            nights: [{ stayDate: CHECK_IN }],
          },
        ],
      })),
    },
  } as unknown as Parameters<typeof sendMemberGuestAddNotifications>[0]["db"];
}

function resolver(
  recipients: Array<{ memberId: string; email: string; firstName: string; isTarget: boolean }>,
): MemberGuestConsentDelegateResolver {
  return {
    canRespondForTarget: vi.fn(async () => false),
    resolveNotificationRecipients: vi.fn(async () => recipients),
  };
}

const TARGET_WITH_LOGIN = [
  { memberId: TARGET, email: "tam@example.com", firstName: "Tam", isTarget: true },
];
const TWO_FAMILY_ADULTS = [
  { memberId: PARENT, email: "parent@example.com", firstName: "Pat", isTarget: false },
  { memberId: OTHER_PARENT, email: "other@example.com", firstName: "Robin", isTarget: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  h.sendConsentRequest.mockResolvedValue({ ok: true });
  h.sendAdded.mockResolvedValue({ ok: true });
});

describe("recipients (owner decision D-9)", () => {
  it("asks the target directly when they hold a login", async () => {
    const result = await sendMemberGuestAddNotifications({
      bookingId: BOOKING,
      rows: [
        {
          bookingGuestId: GUEST_ROW,
          targetMemberId: TARGET,
          notification: "CONSENT_REQUEST",
        },
      ],
      actor: { kind: "MEMBER" },
      db: db(),
      delegateResolver: resolver(TARGET_WITH_LOGIN),
    });

    expect(h.sendConsentRequest).toHaveBeenCalledTimes(1);
    const params = h.sendConsentRequest.mock.calls[0][0];
    expect(params.email).toBe("tam@example.com");
    expect(params.audience).toEqual({ kind: "TARGET" });
    expect(params.bookingId).toBe(BOOKING);
    expect(params.lodgeId).toBe("lodge-1");
    expect(params.bookerName).toBe("Bev Booker");
    // The expiry comes from the COMMITTED row, so the deadline in the email is
    // the one the sweep will act on.
    expect(params.consentExpiresAt).toEqual(EXPIRES);
    expect(params.consentUrl).toContain(`/bookings/${BOOKING}`);
    expect(params.guestNights).toEqual([CHECK_IN]);
    // MG2-D-a: everyone on the booking, names only.
    expect(params.party).toEqual([
      { firstName: "Tam", lastName: "Target" },
      { firstName: "Bev", lastName: "Booker" },
    ]);
    expect(result.sentGuestIds).toEqual([GUEST_ROW]);
  });

  it("reaches the family adults when the target has no login, naming the guest for them", async () => {
    await sendMemberGuestAddNotifications({
      bookingId: BOOKING,
      rows: [
        {
          bookingGuestId: GUEST_ROW,
          targetMemberId: TARGET,
          notification: "CONSENT_REQUEST",
        },
      ],
      actor: { kind: "MEMBER" },
      db: db(),
      delegateResolver: resolver(TWO_FAMILY_ADULTS),
    });

    expect(h.sendConsentRequest).toHaveBeenCalledTimes(2);
    for (const [params] of h.sendConsentRequest.mock.calls) {
      // A delegate must never read "has put YOU down as a guest".
      expect(params.audience).toEqual({
        kind: "DELEGATE",
        guest: { firstName: "Tam", lastName: "Target" },
      });
    }
    expect(h.sendConsentRequest.mock.calls.map(([p]) => p.firstName)).toEqual([
      "Pat",
      "Robin",
    ]);
  });

  it("falls back to the guest's stay envelope when the row has no night rows", async () => {
    await sendMemberGuestAddNotifications({
      bookingId: BOOKING,
      rows: [
        { bookingGuestId: GUEST_ROW, targetMemberId: TARGET, notification: "CONSENT_REQUEST" },
      ],
      actor: { kind: "MEMBER" },
      db: db({ nights: [] }),
      delegateResolver: resolver(TARGET_WITH_LOGIN),
    });

    // Two nights between the 10th and the 12th — never an empty night list.
    expect(h.sendConsentRequest.mock.calls[0][0].guestNights).toHaveLength(2);
  });
});

describe("the added notice", () => {
  it("sends exactly one notice per row on a notify-only add, and never a request", async () => {
    const result = await sendMemberGuestAddNotifications({
      bookingId: BOOKING,
      rows: [
        { bookingGuestId: GUEST_ROW, targetMemberId: TARGET, notification: "ADDED_NOTICE" },
      ],
      actor: { kind: "MEMBER" },
      db: db(),
      delegateResolver: resolver(TARGET_WITH_LOGIN),
    });

    expect(h.sendAdded).toHaveBeenCalledTimes(1);
    expect(h.sendConsentRequest).not.toHaveBeenCalled();
    // Told, not asked: the notify-only opt-down (D-3).
    expect(h.sendAdded.mock.calls[0][0].context).toBe("NOTIFY_ONLY");
    expect(result.sentGuestIds).toEqual([GUEST_ROW]);
  });

  it("says an ADMIN put them there when an admin did (MG4-D-a)", async () => {
    await sendMemberGuestAddNotifications({
      bookingId: BOOKING,
      rows: [
        { bookingGuestId: GUEST_ROW, targetMemberId: TARGET, notification: "ADDED_NOTICE" },
      ],
      actor: { kind: "ADMIN", adminMemberId: ADMIN },
      db: db(),
      delegateResolver: resolver(TARGET_WITH_LOGIN),
    });

    expect(h.sendAdded.mock.calls[0][0].context).toBe("ADMIN");
  });

  it("hands the self-removal predicate its facts rather than a verdict (D-14)", async () => {
    await sendMemberGuestAddNotifications({
      bookingId: BOOKING,
      rows: [
        { bookingGuestId: GUEST_ROW, targetMemberId: TARGET, notification: "ADDED_NOTICE" },
      ],
      actor: { kind: "MEMBER" },
      db: db(),
      delegateResolver: resolver(TARGET_WITH_LOGIN),
    });

    expect(h.sendAdded.mock.calls[0][0].selfRemoval).toEqual({
      actorMemberId: TARGET,
      guestMemberId: TARGET,
      bookingOwnerMemberId: "m-booker",
      bookingStatus: "CONFIRMED",
      bookingCheckIn: CHECK_IN,
      bookingGuestCount: 2,
    });
  });
});

describe("nobody to tell", () => {
  it("logs and audits, does not throw, and does not pretend the member was told", async () => {
    const result = await sendMemberGuestAddNotifications({
      bookingId: BOOKING,
      rows: [
        { bookingGuestId: GUEST_ROW, targetMemberId: TARGET, notification: "CONSENT_REQUEST" },
      ],
      actor: { kind: "MEMBER" },
      db: db(),
      delegateResolver: resolver([]),
    });

    expect(h.sendConsentRequest).not.toHaveBeenCalled();
    expect(result.unreachableGuestIds).toEqual([GUEST_ROW]);
    expect(result.sentGuestIds).toEqual([]);
    expect(h.loggerError).toHaveBeenCalled();
    // Visible to an admin, not only to whoever reads the logs.
    expect(h.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "booking.member_guest.notification_unreachable",
        subjectMemberId: TARGET,
        entityId: GUEST_ROW,
        outcome: "blocked",
      }),
    );
  });
});

describe("isolation", () => {
  it("a failing send is logged and reported, and never rejects", async () => {
    h.sendConsentRequest.mockRejectedValue(new Error("SES is down"));

    const result = await sendMemberGuestAddNotifications({
      bookingId: BOOKING,
      rows: [
        { bookingGuestId: GUEST_ROW, targetMemberId: TARGET, notification: "CONSENT_REQUEST" },
      ],
      actor: { kind: "MEMBER" },
      db: db(),
      delegateResolver: resolver(TARGET_WITH_LOGIN),
    });

    expect(result.failedGuestIds).toEqual([GUEST_ROW]);
    expect(result.sentGuestIds).toEqual([]);
    expect(h.loggerError).toHaveBeenCalled();
  });

  it("one bad address does not stop the other adult in the same household", async () => {
    h.sendConsentRequest
      .mockRejectedValueOnce(new Error("hard bounce"))
      .mockResolvedValueOnce({ ok: true });

    const result = await sendMemberGuestAddNotifications({
      bookingId: BOOKING,
      rows: [
        { bookingGuestId: GUEST_ROW, targetMemberId: TARGET, notification: "CONSENT_REQUEST" },
      ],
      actor: { kind: "MEMBER" },
      db: db(),
      delegateResolver: resolver(TWO_FAMILY_ADULTS),
    });

    expect(h.sendConsentRequest).toHaveBeenCalledTimes(2);
    expect(result.sentGuestIds).toEqual([GUEST_ROW]);
    expect(result.failedGuestIds).toEqual([]);
  });

  it("a resolver failure fails that row only", async () => {
    const broken: MemberGuestConsentDelegateResolver = {
      canRespondForTarget: vi.fn(async () => false),
      resolveNotificationRecipients: vi.fn(async () => {
        throw new Error("database went away");
      }),
    };

    const result = await sendMemberGuestAddNotifications({
      bookingId: BOOKING,
      rows: [
        { bookingGuestId: GUEST_ROW, targetMemberId: TARGET, notification: "CONSENT_REQUEST" },
      ],
      actor: { kind: "MEMBER" },
      db: db(),
      delegateResolver: broken,
    });

    expect(result.failedGuestIds).toEqual([GUEST_ROW]);
  });
});

describe("refusing to send something dishonest", () => {
  it("will not mail a consent request with no deadline in it", async () => {
    // A PENDING row with no expiry is the one shape buildMemberGuestConsentWrite
    // refuses to write, because the sweep cannot see it and it would hold a bed
    // forever. If one exists anyway, do not tell a member they have until "".
    const result = await sendMemberGuestAddNotifications({
      bookingId: BOOKING,
      rows: [
        { bookingGuestId: GUEST_ROW, targetMemberId: TARGET, notification: "CONSENT_REQUEST" },
      ],
      actor: { kind: "MEMBER" },
      db: db({ consentExpiresAt: null }),
      delegateResolver: resolver(TARGET_WITH_LOGIN),
    });

    expect(h.sendConsentRequest).not.toHaveBeenCalled();
    expect(result.failedGuestIds).toEqual([GUEST_ROW]);
    expect(h.loggerError).toHaveBeenCalled();
  });

  it("reports rather than invents when the guest row is not on the booking", async () => {
    const result = await sendMemberGuestAddNotifications({
      bookingId: BOOKING,
      rows: [
        { bookingGuestId: "bg-elsewhere", targetMemberId: TARGET, notification: "ADDED_NOTICE" },
      ],
      actor: { kind: "MEMBER" },
      db: db(),
      delegateResolver: resolver(TARGET_WITH_LOGIN),
    });

    expect(h.sendAdded).not.toHaveBeenCalled();
    expect(result.failedGuestIds).toEqual(["bg-elsewhere"]);
  });
});

describe("the ordinary booking pays nothing", () => {
  it("does not read the database at all when no row owes anything", async () => {
    const client = db();
    const delegate = resolver(TARGET_WITH_LOGIN);

    const result = await sendMemberGuestAddNotifications({
      bookingId: BOOKING,
      // What a family-scope add produces (D-6): a row that owes nobody anything.
      rows: [{ bookingGuestId: GUEST_ROW, targetMemberId: TARGET, notification: "NONE" }],
      actor: { kind: "MEMBER" },
      db: client,
      delegateResolver: delegate,
    });

    expect(
      (client as unknown as { booking: { findUnique: ReturnType<typeof vi.fn> } }).booking
        .findUnique,
    ).not.toHaveBeenCalled();
    expect(delegate.resolveNotificationRecipients).not.toHaveBeenCalled();
    expect(h.sendConsentRequest).not.toHaveBeenCalled();
    expect(h.sendAdded).not.toHaveBeenCalled();
    expect(result).toEqual({
      sentGuestIds: [],
      failedGuestIds: [],
      unreachableGuestIds: [],
    });
  });
});
