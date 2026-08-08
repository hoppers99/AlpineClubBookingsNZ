import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #2664 — the booking-scoped requested-room options read.
 *
 * The defect these tests pin: the picker used to load `/api/bookings/rooms`
 * with no scope, so it offered every lodge's rooms to anyone eligible to book
 * them, and it filtered a Booking Officer's choices by that officer's OWN
 * member booking eligibility rather than by the authority their write actually
 * runs under.
 *
 * Two properties are asserted throughout, and they are the whole contract:
 *
 *  - the room query is scoped by the lodge read off the BOOKING ROW, never by
 *    anything a caller supplied; and
 *  - `memberLodgeAccess` — the BOOKING_RESTRICTION table behind
 *    `isMemberEligibleToBookLodge` — is never consulted, in either direction.
 *    That single mock is the one that catches both halves of the old bug: it
 *    would have to be read to filter a cross-lodge listing, and it would have to
 *    be read to refuse an officer their own personally-forbidden lodge.
 *
 * `@/lib/access-roles`, `@/lib/admin-permissions` and `@/lib/lodges` are left
 * UN-mocked so the real role resolution and the real lodge scope helper run.
 */
const {
  mockAuth,
  mockRequireActiveSessionUser,
  mockLoadEffectiveModuleFlags,
  mockBookingFindUnique,
  mockLodgeRoomFindMany,
  mockMemberLodgeAccessFindMany,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireActiveSessionUser: vi.fn(),
  mockLoadEffectiveModuleFlags: vi.fn(),
  mockBookingFindUnique: vi.fn(),
  mockLodgeRoomFindMany: vi.fn(),
  mockMemberLodgeAccessFindMany: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mockAuth() }));
vi.mock("@/lib/session-guards", () => ({
  requireActiveSessionUser: (...args: unknown[]) =>
    mockRequireActiveSessionUser(...args),
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: () => mockLoadEffectiveModuleFlags(),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: mockBookingFindUnique },
    lodgeRoom: { findMany: mockLodgeRoomFindMany },
    memberLodgeAccess: { findMany: mockMemberLodgeAccessFindMany },
  },
}));

// Two lodges, three rooms. Cedar is lodge B's, and no caller on a lodge A
// booking may ever be offered it; Attic is lodge A's but retired, so it is not
// a fresh choice either.
const ALL_ROOMS = [
  {
    id: "room-alpine",
    name: "Alpine",
    lodgeId: "lodge-a",
    active: true,
    beds: [{ id: "bed-1" }, { id: "bed-2" }],
  },
  {
    id: "room-attic",
    name: "Attic",
    lodgeId: "lodge-a",
    active: false,
    beds: [{ id: "bed-3" }],
  },
  {
    id: "room-cedar",
    name: "Cedar",
    lodgeId: "lodge-b",
    active: true,
    beds: [{ id: "bed-4" }],
  },
];

/**
 * A findMany that really applies the `where` it is given. Asserting on the
 * argument alone would pass for a route that built a correct filter and then
 * ignored it; filtering the fixture means "no lodge B room in the body" is a
 * statement about the response the caller receives.
 */
function roomsMatching(where: {
  active?: boolean;
  lodgeId?: string | { in: string[] };
}) {
  return ALL_ROOMS.filter((room) => {
    if (where.active === true && !room.active) return false;
    if (typeof where.lodgeId === "string" && room.lodgeId !== where.lodgeId) {
      return false;
    }
    if (
      where.lodgeId &&
      typeof where.lodgeId === "object" &&
      !where.lodgeId.in.includes(room.lodgeId)
    ) {
      return false;
    }
    return true;
  });
}

const OWNER = {
  user: { id: "owner-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const STRANGER = {
  user: { id: "stranger-1", role: "MEMBER", accessRoles: [{ role: "USER" }] },
};
const FULL_ADMIN = {
  user: { id: "admin-1", role: "ADMIN", accessRoles: [{ role: "ADMIN" }] },
};
// A Booking Officer: `bookings:edit` through the ADMIN_BOOKINGS bundle, and no
// Full Admin role. This is the account the old read got wrong.
const BOOKING_OFFICER = {
  user: {
    id: "officer-1",
    role: "MEMBER",
    accessRoles: [{ role: "ADMIN_BOOKINGS" }],
  },
};
// A member with bookings VIEW only (read-only admin). They can reach the
// booking page, but they cannot edit the requested room, so they get no options.
const READ_ONLY_ADMIN = {
  user: {
    id: "readonly-1",
    role: "MEMBER",
    accessRoles: [{ role: "ADMIN_READONLY" }],
  },
};

function request() {
  return new NextRequest(
    "http://localhost/api/bookings/booking-a/requested-room/options",
  );
}

async function callRoute(bookingId = "booking-a") {
  const { GET } = await import(
    "@/app/api/bookings/[id]/requested-room/options/route"
  );
  return GET(request(), { params: Promise.resolve({ id: bookingId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireActiveSessionUser.mockResolvedValue(null);
  mockLoadEffectiveModuleFlags.mockResolvedValue({ bedAllocation: true });
  // The booking under edit lives at lodge A, belongs to owner-1, and is live.
  mockBookingFindUnique.mockResolvedValue({
    memberId: "owner-1",
    lodgeId: "lodge-a",
    deletedAt: null,
  });
  mockLodgeRoomFindMany.mockImplementation(
    async (args: { where: Parameters<typeof roomsMatching>[0] }) =>
      roomsMatching(args.where),
  );
  // Default-open eligibility: nobody here is restricted, so a route that DID
  // consult personal eligibility would still pass the happy path. The tests
  // that matter assert this table is never read at all.
  mockMemberLodgeAccessFindMany.mockResolvedValue([]);
});

describe("GET /api/bookings/[id]/requested-room/options (#2664)", () => {
  it("offers only the booking's own lodge, to an owner eligible for both lodges", async () => {
    // The headline case. owner-1 has no BOOKING_RESTRICTION rows, so the old
    // unscoped read would have handed them lodge B's Cedar on a lodge A booking
    // — a room the writer refuses under its lock with a 400.
    mockAuth.mockResolvedValue(OWNER);

    const res = await callRoute();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(body.rooms).toEqual([
      { id: "room-alpine", name: "Alpine", bedCount: 2 },
    ]);
    expect(body.rooms.map((room: { id: string }) => room.id)).not.toContain(
      "room-cedar",
    );
    expect(mockLodgeRoomFindMany.mock.calls[0][0].where).toEqual({
      active: true,
      lodgeId: "lodge-a",
    });
    // Derived from the booking row, never from the request.
    expect(mockBookingFindUnique).toHaveBeenCalledWith({
      where: { id: "booking-a" },
      select: { memberId: true, lodgeId: true, deletedAt: true },
    });
    expect(mockMemberLodgeAccessFindMany).not.toHaveBeenCalled();
  });

  it("ignores a lodgeId a caller tries to smuggle in on the query string", async () => {
    // There is no client-supplied lodge in this contract at all. Naming lodge B
    // changes nothing: the scope comes off the booking row.
    mockAuth.mockResolvedValue(OWNER);
    const { GET } = await import(
      "@/app/api/bookings/[id]/requested-room/options/route"
    );

    const res = await GET(
      new NextRequest(
        "http://localhost/api/bookings/booking-a/requested-room/options?lodgeId=lodge-b",
      ),
      { params: Promise.resolve({ id: "booking-a" }) },
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.rooms).toEqual([
      { id: "room-alpine", name: "Alpine", bedCount: 2 },
    ]);
    expect(mockLodgeRoomFindMany.mock.calls[0][0].where.lodgeId).toBe("lodge-a");
  });

  it("lets a Booking Officer load options for a lodge they could not personally book", async () => {
    // The inverse case, and the one a naive fix gets wrong. The officer's own
    // member account is restricted away from lodge A; their authority here is
    // `bookings:edit` on the booking, which is what their WRITE runs under
    // (/api/admin/bookings/[id]/requested-room). If the route consulted
    // isMemberEligibleToBookLodge it would have to read memberLodgeAccess, and
    // would then refuse or empty the very list the officer is entitled to.
    mockAuth.mockResolvedValue(BOOKING_OFFICER);
    mockMemberLodgeAccessFindMany.mockResolvedValue([{ lodgeId: "lodge-b" }]);

    const res = await callRoute();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.rooms).toEqual([
      { id: "room-alpine", name: "Alpine", bedCount: 2 },
    ]);
    expect(mockMemberLodgeAccessFindMany).not.toHaveBeenCalled();
  });

  it("lets a Full Admin load options, still scoped to the booking's lodge", async () => {
    mockAuth.mockResolvedValue(FULL_ADMIN);
    mockMemberLodgeAccessFindMany.mockResolvedValue([{ lodgeId: "lodge-b" }]);

    const res = await callRoute();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.rooms).toEqual([
      { id: "room-alpine", name: "Alpine", bedCount: 2 },
    ]);
    expect(mockMemberLodgeAccessFindMany).not.toHaveBeenCalled();
  });

  it("refuses a member who is not authorised for the booking, and reads no rooms", async () => {
    // The IDOR check. A stranger must not be able to use this read to enumerate
    // another booking's lodge inventory.
    mockAuth.mockResolvedValue(STRANGER);

    const res = await callRoute();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(mockLodgeRoomFindMany).not.toHaveBeenCalled();
  });

  it("refuses a bookings:view-only admin who is not the owner", async () => {
    // Read-only admins reach the booking page but cannot edit the requested
    // room, so the options read stays on the edit authority its writes use.
    mockAuth.mockResolvedValue(READ_ONLY_ADMIN);

    const res = await callRoute();

    expect(res.status).toBe(403);
    expect(mockLodgeRoomFindMany).not.toHaveBeenCalled();
  });

  it("never offers an inactive room as a fresh choice", async () => {
    // Attic is lodge A's, and retired. A booking already holding it still shows
    // it (from the server-rendered booking, through the editor's
    // storedInactiveOption), but it is never a room a booking may newly request.
    mockAuth.mockResolvedValue(OWNER);

    const res = await callRoute();
    const body = await res.json();

    expect(body.rooms.map((room: { id: string }) => room.id)).not.toContain(
      "room-attic",
    );
    expect(mockLodgeRoomFindMany.mock.calls[0][0].where.active).toBe(true);
  });

  // A soft-deleted booking is not found here for ANY role. The picker is
  // hard-disabled on a deleted booking (`canEditRequestedRoom` is
  // `isDeleted ? false : ...`), so no caller of any role can act on the answer.
  // The page's own Full-Admin exemption is deliberately NOT copied: the page is
  // a record-viewing surface, this route is not.
  it.each([
    ["the owner", OWNER],
    ["a Booking Officer", BOOKING_OFFICER],
    ["a Full Admin", FULL_ADMIN],
  ])("returns 404 on a soft-deleted booking for %s", async (_who, session) => {
    mockAuth.mockResolvedValue(session);
    mockBookingFindUnique.mockResolvedValue({
      memberId: "owner-1",
      lodgeId: "lodge-a",
      deletedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    const res = await callRoute();

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Booking not found" });
    expect(mockLodgeRoomFindMany).not.toHaveBeenCalled();
  });

  it("still answers 403, not 404, to a stranger on a soft-deleted booking", async () => {
    // The deletion check sits AFTER the authority check on purpose. Checking it
    // first would answer 404 for a deleted booking and 403 for a live one,
    // handing an unauthorised caller a deleted-or-live oracle on a booking they
    // have no claim to.
    mockAuth.mockResolvedValue(STRANGER);
    mockBookingFindUnique.mockResolvedValue({
      memberId: "owner-1",
      lodgeId: "lodge-a",
      deletedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    const res = await callRoute();

    expect(res.status).toBe(403);
    expect(mockLodgeRoomFindMany).not.toHaveBeenCalled();
  });

  it("returns 404 for a booking that does not exist, before any room read", async () => {
    mockAuth.mockResolvedValue(OWNER);
    mockBookingFindUnique.mockResolvedValue(null);

    const res = await callRoute("booking-missing");

    expect(res.status).toBe(404);
    expect(mockLodgeRoomFindMany).not.toHaveBeenCalled();
  });

  it("returns 401 without a session", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await callRoute();

    expect(res.status).toBe(401);
    expect(mockBookingFindUnique).not.toHaveBeenCalled();
  });

  it("honours the inactive-account guard", async () => {
    mockAuth.mockResolvedValue(OWNER);
    mockRequireActiveSessionUser.mockResolvedValue(
      new Response(null, { status: 403 }),
    );

    const res = await callRoute();

    expect(res.status).toBe(403);
    expect(mockBookingFindUnique).not.toHaveBeenCalled();
  });

  it("reports the module as off rather than listing rooms", async () => {
    mockAuth.mockResolvedValue(OWNER);
    mockLoadEffectiveModuleFlags.mockResolvedValue({ bedAllocation: false });

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, rooms: [] });
    expect(mockLodgeRoomFindMany).not.toHaveBeenCalled();
  });
});
