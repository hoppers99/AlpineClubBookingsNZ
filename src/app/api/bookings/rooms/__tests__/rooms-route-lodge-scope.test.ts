import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * `GET /api/bookings/rooms` — the two lodge-scoping modes (#2727, #1587, #2678).
 *
 * This endpoint's unscoped mode is kept for consumers OUTSIDE this repository
 * (`INV-INT-016`), and since #2677 nothing in `src/` calls it. That is exactly
 * why these tests exist: no page, hook or E2E journey walks the unscoped branch
 * any more, so this file is the only thing that will ever exercise it again.
 *
 * What it pins:
 *
 *  - **Unscoped (no `lodgeId`) is a DISCOVERY listing and excludes ARCHIVED
 *    lodges** (#2727). It used to filter on `LodgeRoom.active` and the member's
 *    `BOOKING_RESTRICTION` rows but never on the lodge's own `active` flag, so
 *    an unrestricted member was offered rooms at lodges the club had closed,
 *    sold or shut for the season. Both eligibility shapes are covered: a
 *    default-open member, and a restricted member with an archived lodge inside
 *    their own eligible set.
 *  - **Scoped (`?lodgeId=`) is UNCHANGED** — it still answers `403` for a member
 *    barred from that lodge, and it still returns a named lodge's rooms without
 *    consulting the lodge's `active` flag. The asymmetry is deliberate: a
 *    listing omits what the member cannot see, a named resource refuses.
 *
 * The `lodgeRoom.findMany` mock really applies the `where` it is handed, so an
 * assertion about the response body is a statement about what a caller receives
 * — not merely about the filter the route built and might have ignored.
 */
const {
  mockAuth,
  mockRequireActiveSessionUser,
  mockLoadEffectiveModuleFlags,
  mockLodgeRoomFindMany,
  mockMemberLodgeAccessFindMany,
} = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRequireActiveSessionUser: vi.fn(),
  mockLoadEffectiveModuleFlags: vi.fn(),
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
    lodgeRoom: { findMany: mockLodgeRoomFindMany },
    memberLodgeAccess: { findMany: mockMemberLodgeAccessFindMany },
  },
}));

// `@/lib/lodge-access` and `@/lib/lodges` are left UN-mocked so the real
// eligibility resolution and the real lodge scope helper run.

// Three lodges. Alpine Lodge is open; Old Hut is ARCHIVED (closed, sold or shut
// for the season — `Lodge.active = false`); Cedar Lodge is open and is the one
// a restricted member is barred from.
const LODGES: Record<string, { active: boolean }> = {
  "lodge-alpine": { active: true },
  "lodge-oldhut": { active: false },
  "lodge-cedar": { active: true },
};

const ALL_ROOMS = [
  {
    id: "room-alpine-bunk",
    name: "Alpine Bunkroom",
    lodgeId: "lodge-alpine",
    active: true,
    beds: [{ id: "bed-1" }, { id: "bed-2" }],
  },
  {
    id: "room-alpine-attic",
    name: "Alpine Attic",
    lodgeId: "lodge-alpine",
    active: false,
    beds: [{ id: "bed-3" }],
  },
  {
    id: "room-oldhut-main",
    name: "Old Hut Main Room",
    lodgeId: "lodge-oldhut",
    active: true,
    beds: [{ id: "bed-4" }, { id: "bed-5" }],
  },
  {
    id: "room-cedar-loft",
    name: "Cedar Loft",
    lodgeId: "lodge-cedar",
    active: true,
    beds: [{ id: "bed-6" }],
  },
];

type RoomWhere = {
  active?: boolean;
  lodgeId?: string | { in: string[] };
  lodge?: { active?: boolean };
};

function roomsMatching(where: RoomWhere) {
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
    if (
      where.lodge?.active === true &&
      !LODGES[room.lodgeId as keyof typeof LODGES].active
    ) {
      return false;
    }
    return true;
  });
}

const MEMBER = { user: { id: "member-1", role: "MEMBER" } };

async function callRoute(query = "") {
  const { GET } = await import("@/app/api/bookings/rooms/route");
  return GET(new NextRequest(`http://localhost/api/bookings/rooms${query}`));
}

function roomIds(body: { rooms: { id: string }[] }) {
  return body.rooms.map((room) => room.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(MEMBER);
  mockRequireActiveSessionUser.mockResolvedValue(null);
  mockLoadEffectiveModuleFlags.mockResolvedValue({ bedAllocation: true });
  // Default-open: no BOOKING_RESTRICTION rows.
  mockMemberLodgeAccessFindMany.mockResolvedValue([]);
  mockLodgeRoomFindMany.mockImplementation(
    async (args: { where: RoomWhere }) => roomsMatching(args.where),
  );
});

describe("GET /api/bookings/rooms — unscoped cross-lodge listing (#2727)", () => {
  it("excludes an archived lodge's rooms from an unrestricted member's listing", async () => {
    // The headline case, and the one that fails if the lodge filter is removed:
    // member-1 has no restrictions, so before #2727 Old Hut's Main Room came
    // back in a listing whose whole purpose is "where could I book?".
    const res = await callRoute();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.enabled).toBe(true);
    expect(roomIds(body)).toEqual(["room-alpine-bunk", "room-cedar-loft"]);
    expect(roomIds(body)).not.toContain("room-oldhut-main");
    expect(mockLodgeRoomFindMany.mock.calls[0][0].where).toEqual({
      active: true,
      lodge: { active: true },
    });
  });

  it("excludes an archived lodge that sits inside a RESTRICTED member's own eligible set", async () => {
    // A BOOKING_RESTRICTION set is an allow-list, and a lodge on it can be
    // archived afterwards. Eligibility and service state are two different
    // questions, so narrowing to the member's lodges must not re-admit a lodge
    // the club has taken out of service.
    mockMemberLodgeAccessFindMany.mockResolvedValue([
      { lodgeId: "lodge-oldhut" },
      { lodgeId: "lodge-alpine" },
    ]);

    const res = await callRoute();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(roomIds(body)).toEqual(["room-alpine-bunk"]);
    expect(mockLodgeRoomFindMany.mock.calls[0][0].where).toEqual({
      active: true,
      lodgeId: { in: ["lodge-oldhut", "lodge-alpine"] },
      lodge: { active: true },
    });
  });

  it("returns an empty listing, never a 403, when every eligible lodge is archived", async () => {
    // A listing omits what the member cannot see (matching /api/lodges); it
    // never refuses. Emptiness is the correct answer here, not an error.
    mockMemberLodgeAccessFindMany.mockResolvedValue([
      { lodgeId: "lodge-oldhut" },
    ]);

    const res = await callRoute();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ enabled: true, rooms: [] });
  });

  it("still SERVES the unscoped mode rather than demanding a lodgeId (INV-INT-016)", async () => {
    // The complement of the #2727 fix: excluding archived lodges narrows what
    // the mode returns, it does not retire the mode. A fork's pre-multi-lodge
    // call must still get a 200 listing, not a 400.
    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(mockLodgeRoomFindMany).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/bookings/rooms — named-lodge mode is unchanged (#1587)", () => {
  it("403s a member barred from the lodge they name", async () => {
    mockMemberLodgeAccessFindMany.mockResolvedValue([
      { lodgeId: "lodge-alpine" },
    ]);

    const res = await callRoute("?lodgeId=lodge-cedar");
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe("This member cannot book the selected lodge.");
    expect(mockLodgeRoomFindMany).not.toHaveBeenCalled();
  });

  it("returns only the named lodge's active rooms for an eligible member", async () => {
    const res = await callRoute("?lodgeId=lodge-alpine");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(roomIds(body)).toEqual(["room-alpine-bunk"]);
    // No `lodge: { active: true }` here: the archived-lodge exclusion is a
    // property of the DISCOVERY listing only.
    expect(mockLodgeRoomFindMany.mock.calls[0][0].where).toEqual({
      active: true,
      lodgeId: "lodge-alpine",
    });
  });

  it("still answers for an archived lodge the caller names explicitly", async () => {
    // Deliberate and pinned so it cannot be changed by accident: naming a lodge
    // is not discovery. A caller holding an archived lodge's id — an operator
    // winding a property down, a fork's admin tool — still reads its rooms, and
    // the booking writers refuse a booking there regardless. Changing this is a
    // separate decision from #2727.
    const res = await callRoute("?lodgeId=lodge-oldhut");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(roomIds(body)).toEqual(["room-oldhut-main"]);
  });
});

describe("GET /api/bookings/rooms — guards ahead of the lodge scope", () => {
  it("401s an unauthenticated caller before any lodge work", async () => {
    mockAuth.mockResolvedValue(null);

    const res = await callRoute();

    expect(res.status).toBe(401);
    expect(mockMemberLodgeAccessFindMany).not.toHaveBeenCalled();
    expect(mockLodgeRoomFindMany).not.toHaveBeenCalled();
  });

  it("reports the module disabled without querying rooms", async () => {
    mockLoadEffectiveModuleFlags.mockResolvedValue({ bedAllocation: false });

    const res = await callRoute();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ enabled: false, rooms: [] });
    expect(mockLodgeRoomFindMany).not.toHaveBeenCalled();
  });
});
