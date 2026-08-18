import { describe, it, expect, vi } from "vitest";
import { syncBookingOfficerForRole } from "@/lib/committee-booking-officer-sync";

// The sync accepts a narrow Prisma-shaped client, so we drive it with a hand-built
// fake instead of mocking the module. Each test wires the reads it needs and
// asserts on the otherLodge.update calls (the observable effect).

const MEMBER = {
  firstName: "Andy",
  lastName: "Schulz",
  phoneCountryCode: "64",
  phoneAreaCode: "27",
  phoneNumber: "4224115",
};

// The booking-officer email is the ROLE's shared contact address, not the
// member's personal email.
const ROLE_CONTACT_EMAIL = "bookings@club.test";

function makeDb(opts: {
  roles?: Array<{ id: string }>;
  holder?: {
    memberId: string;
    member: typeof MEMBER;
    committeeRole: { contactEmail: string | null };
  } | null;
  lodges?: Array<{ name: string }>;
  otherLodges?: Array<{
    id: string;
    bookingOfficerName: string | null;
    bookingOfficerEmail: string | null;
    bookingOfficerPhone: string | null;
  }>;
}) {
  const update = vi.fn().mockResolvedValue({});
  const db = {
    committeeRole: {
      findMany: vi.fn().mockResolvedValue(opts.roles ?? []),
    },
    committeeAssignment: {
      findFirst: vi.fn().mockResolvedValue(opts.holder ?? null),
    },
    lodge: {
      findMany: vi.fn().mockResolvedValue(opts.lodges ?? []),
    },
    otherLodge: {
      findMany: vi.fn().mockResolvedValue(opts.otherLodges ?? []),
      update,
    },
  };
  return { db, update };
}

describe("syncBookingOfficerForRole", () => {
  it("does nothing for a role that is not the Booking Officer", async () => {
    const { db, update } = makeDb({ roles: [{ id: "role_bo" }] });
    const result = await syncBookingOfficerForRole(
      db as never,
      "role_president",
    );
    expect(result).toBeNull();
    expect(db.committeeAssignment.findFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("writes the holder's contact into the OtherLodge row matching the lodge name", async () => {
    const { db, update } = makeDb({
      roles: [{ id: "role_bo" }],
      holder: {
        memberId: "m1",
        member: MEMBER,
        committeeRole: { contactEmail: ROLE_CONTACT_EMAIL },
      },
      lodges: [{ name: "Whakapapa Lodge" }],
      otherLodges: [
        {
          id: "ol1",
          bookingOfficerName: null,
          bookingOfficerEmail: null,
          bookingOfficerPhone: null,
        },
      ],
    });

    const result = await syncBookingOfficerForRole(db as never, "role_bo");

    expect(result).toEqual({ updated: 1, holderMemberId: "m1" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { id: "ol1" },
      data: {
        bookingOfficerName: "Andy Schulz",
        // Role's shared contact email, not the member's personal address.
        bookingOfficerEmail: ROLE_CONTACT_EMAIL,
        bookingOfficerPhone: "64 27 4224115",
      },
    });
  });

  it("skips a row whose contact already matches (no needless updatedAt bump)", async () => {
    const { db, update } = makeDb({
      roles: [{ id: "role_bo" }],
      holder: {
        memberId: "m1",
        member: MEMBER,
        committeeRole: { contactEmail: ROLE_CONTACT_EMAIL },
      },
      lodges: [{ name: "Whakapapa Lodge" }],
      otherLodges: [
        {
          id: "ol1",
          bookingOfficerName: "Andy Schulz",
          bookingOfficerEmail: ROLE_CONTACT_EMAIL,
          bookingOfficerPhone: "64 27 4224115",
        },
      ],
    });

    const result = await syncBookingOfficerForRole(db as never, "role_bo");
    expect(result).toEqual({ updated: 0, holderMemberId: "m1" });
    expect(update).not.toHaveBeenCalled();
  });

  it("clears the contact when the role has no active holder", async () => {
    const { db, update } = makeDb({
      roles: [{ id: "role_bo" }],
      holder: null,
      lodges: [{ name: "Whakapapa Lodge" }],
      otherLodges: [
        {
          id: "ol1",
          bookingOfficerName: "Andy Schulz",
          bookingOfficerEmail: "andy@example.com",
          bookingOfficerPhone: "64 27 4224115",
        },
      ],
    });

    const result = await syncBookingOfficerForRole(db as never, "role_bo");
    expect(result).toEqual({ updated: 1, holderMemberId: null });
    expect(update.mock.calls[0][0]).toMatchObject({
      where: { id: "ol1" },
      data: {
        bookingOfficerName: null,
        bookingOfficerEmail: null,
        bookingOfficerPhone: null,
      },
    });
  });

  it("matches the Booking Officer role by key or name fallback", async () => {
    // Role resolved via the OR(key, name) query; the affected id is included.
    const { db } = makeDb({
      roles: [{ id: "role_bo" }],
      holder: {
        memberId: "m1",
        member: MEMBER,
        committeeRole: { contactEmail: ROLE_CONTACT_EMAIL },
      },
      lodges: [{ name: "Whakapapa Lodge" }],
      otherLodges: [],
    });
    await syncBookingOfficerForRole(db as never, "role_bo");
    const where = db.committeeRole.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { key: "bookings" },
      { name: { equals: "Booking Officer", mode: "insensitive" } },
    ]);
  });
});
