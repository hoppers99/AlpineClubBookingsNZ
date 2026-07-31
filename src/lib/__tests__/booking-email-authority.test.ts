import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bookingFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mocks.bookingFindUnique },
    member: { findUnique: mocks.memberFindUnique },
  },
}));
vi.mock("@/lib/logger", () => ({
  default: { error: mocks.loggerError },
}));

import { resolveBookingEmailLink } from "@/lib/booking-email-authority";

const ACTIVE_MEMBER = {
  role: "MEMBER",
  financeAccessLevel: "NONE",
  active: true,
  archivedAt: null,
  canLogin: true,
  accessRoles: [{ role: "USER", roleDefinitionId: null, roleDefinition: null }],
};

function booking(params?: {
  memberId?: string;
  linked?: boolean;
  deleted?: boolean;
}) {
  return {
    memberId: params?.memberId ?? "owner_1",
    deletedAt: params?.deleted ? new Date("2026-08-01T00:00:00Z") : null,
    guests: params?.linked ? [{ id: "guest_1" }] : [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NEXTAUTH_URL", "https://bookings.example.nz/base-path");
  mocks.bookingFindUnique.mockResolvedValue(booking());
  mocks.memberFindUnique.mockResolvedValue(ACTIVE_MEMBER);
});

describe("booking email detail-link authority", () => {
  it("gives the signed-in owner the canonical encoded detail URL", async () => {
    mocks.bookingFindUnique.mockResolvedValue(booking({ memberId: "owner_1" }));

    await expect(
      resolveBookingEmailLink({
        bookingId: "bk/one ?",
        templateName: "booking-confirmed",
        recipient: { kind: "member", memberId: "owner_1" },
      }),
    ).resolves.toEqual({
      authority: "signed-in-booking-owner",
      bookingUrl: "https://bookings.example.nz/bookings/bk%2Fone%20%3F",
    });
    expect(mocks.memberFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "owner_1" } }),
    );
  });

  it("allows an explicitly identified linked member", async () => {
    mocks.bookingFindUnique.mockResolvedValue(booking({ linked: true }));

    await expect(
      resolveBookingEmailLink({
        bookingId: "bk_1",
        templateName: "chore-roster",
        recipient: { kind: "member", memberId: "guest_member_1" },
      }),
    ).resolves.toMatchObject({
      authority: "signed-in-linked-member",
      bookingUrl: "https://bookings.example.nz/bookings/bk_1",
    });
  });

  it("allows a bookings-view admin but not an unrelated member", async () => {
    mocks.memberFindUnique.mockResolvedValue({
      ...ACTIVE_MEMBER,
      accessRoles: [
        { role: "ADMIN_READONLY", roleDefinitionId: null, roleDefinition: null },
      ],
    });
    await expect(
      resolveBookingEmailLink({
        bookingId: "bk_1",
        templateName: "refund-request-approved",
        recipient: { kind: "member", memberId: "viewer_1" },
      }),
    ).resolves.toMatchObject({ authority: "bookings-view-admin" });

    mocks.memberFindUnique.mockResolvedValue(ACTIVE_MEMBER);
    await expect(
      resolveBookingEmailLink({
        bookingId: "bk_1",
        templateName: "refund-request-approved",
        recipient: { kind: "member", memberId: "stranger_1" },
      }),
    ).resolves.toEqual({ authority: "unauthorized", bookingUrl: null });
  });

  it.each(["non-login-public-contact", "aggregate-operator"] as const)(
    "omits the authenticated URL for %s without querying member data",
    async (kind) => {
      await expect(
        resolveBookingEmailLink({
          bookingId: "bk_private",
          templateName: "booking-confirmed",
          recipient: { kind },
        }),
      ).resolves.toEqual({ authority: kind, bookingUrl: null });
      expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
      expect(mocks.memberFindUnique).not.toHaveBeenCalled();
    },
  );

  it("fails closed for disabled login, deleted-booking non-admin, and query errors", async () => {
    mocks.memberFindUnique.mockResolvedValue({ ...ACTIVE_MEMBER, canLogin: false });
    await expect(
      resolveBookingEmailLink({
        bookingId: "bk_1",
        templateName: "booking-confirmed",
        recipient: { kind: "member", memberId: "owner_1" },
      }),
    ).resolves.toEqual({ authority: "unauthorized", bookingUrl: null });

    mocks.bookingFindUnique.mockResolvedValue(booking({ deleted: true }));
    mocks.memberFindUnique.mockResolvedValue(ACTIVE_MEMBER);
    await expect(
      resolveBookingEmailLink({
        bookingId: "bk_1",
        templateName: "booking-confirmed",
        recipient: { kind: "member", memberId: "owner_1" },
      }),
    ).resolves.toEqual({ authority: "unauthorized", bookingUrl: null });

    mocks.bookingFindUnique.mockRejectedValue(new Error("database unavailable"));
    await expect(
      resolveBookingEmailLink({
        bookingId: "bk_1",
        templateName: "booking-confirmed",
        recipient: { kind: "member", memberId: "owner_1" },
      }),
    ).resolves.toEqual({ authority: "unauthorized", bookingUrl: null });
    expect(mocks.loggerError).toHaveBeenCalledTimes(1);
  });

  it("does not classify templates outside the booking-scoped inventory", async () => {
    await expect(
      resolveBookingEmailLink({
        bookingId: "bk_1",
        templateName: "admin-daily-digest",
        recipient: { kind: "member", memberId: "owner_1" },
      }),
    ).resolves.toEqual({ authority: "unauthorized", bookingUrl: null });
    expect(mocks.bookingFindUnique).not.toHaveBeenCalled();
  });
});
