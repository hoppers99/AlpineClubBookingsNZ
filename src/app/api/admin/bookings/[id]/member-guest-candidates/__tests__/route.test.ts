import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MG4 (#2309): the officer's member-guest picker.
 *
 * Three properties are tested and each of them is a decision, not an
 * implementation detail: the name mode is gated on `membership:view` (owner
 * decision D-20, rider (a) — the #1376 persona must not get a directory
 * type-ahead through the booking door), every lookup is audited (rider (b)), and
 * an officer's search is not bound by the club's member-facing minors switch.
 */

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  hasAdminAreaAccess: vi.fn(),
  loadMemberGuestFindGate: vi.fn(),
  resolveByEmail: vi.fn(),
  searchByName: vi.fn(),
  auditResolve: vi.fn(),
  auditSearch: vi.fn(),
}));

vi.mock("@/lib/session-guards", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/admin-permissions", () => ({
  hasAdminAreaAccess: mocks.hasAdminAreaAccess,
}));
vi.mock("@/lib/member-guest-find-service", () => ({
  loadMemberGuestFindGate: mocks.loadMemberGuestFindGate,
  resolveMemberGuestCandidatesByEmail: mocks.resolveByEmail,
  searchMemberGuestCandidatesByName: mocks.searchByName,
  auditMemberGuestResolve: mocks.auditResolve,
  auditMemberGuestSearch: mocks.auditSearch,
}));
vi.mock("@/lib/logger", () => ({ default: { error: vi.fn(), warn: vi.fn() } }));

import { GET } from "@/app/api/admin/bookings/[id]/member-guest-candidates/route";

const SETTINGS = {
  approvalRequired: true,
  pendingHoldExpiryDays: 7,
  openMemberSearchEnabled: false,
  openMemberSearchIncludesMinors: false,
};

function request(query: string) {
  return new NextRequest(
    `https://club.example.org/api/admin/bookings/bk-1/member-guest-candidates${query}`,
  );
}

const params = Promise.resolve({ id: "bk-1" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdmin.mockResolvedValue({
    ok: true,
    session: { user: { id: "admin-1" } },
  });
  mocks.hasAdminAreaAccess.mockReturnValue(true);
  mocks.loadMemberGuestFindGate.mockResolvedValue({ ok: true, settings: SETTINGS });
  mocks.resolveByEmail.mockResolvedValue({ candidates: [] });
  mocks.searchByName.mockResolvedValue({ candidates: [], truncated: false });
});

describe("the gate", () => {
  it("does not exist at all when the club has the module off", async () => {
    // 404 rather than 403: a 403 would confirm the club HAS the feature and
    // merely switched it off, which is a fact about the club.
    mocks.loadMemberGuestFindGate.mockResolvedValue({ ok: false });
    const res = await GET(request("?q=whit"), { params });
    expect(res.status).toBe(404);
    expect(mocks.searchByName).not.toHaveBeenCalled();
  });

  it("ignores the club's OPEN-SEARCH setting, which is a member-facing switch", async () => {
    // `requiresOpenSearch: false` is the whole point: an officer's picker is not
    // bound by whether members may browse. If this route asked for the open
    // gate, name search would be dead for every club shipping the default.
    await GET(request("?q=whit"), { params });
    expect(mocks.loadMemberGuestFindGate).toHaveBeenCalledWith({
      requiresOpenSearch: false,
    });
    expect(mocks.searchByName).toHaveBeenCalled();
  });

  it("refuses the NAME mode to an officer without membership:view, and says nothing about why", async () => {
    // #1376's persona: a Booking Officer whose role deliberately carries no
    // membership access. Handing them a type-ahead over the whole roll from
    // inside a booking would undo that issue through a door nobody looked at.
    mocks.hasAdminAreaAccess.mockReturnValue(false);
    const res = await GET(request("?q=whit"), { params });
    expect(res.status).toBe(404);
    expect(mocks.searchByName).not.toHaveBeenCalled();
    expect(mocks.hasAdminAreaAccess).toHaveBeenCalledWith(
      { id: "admin-1" },
      { area: "membership", level: "view" },
    );
  });

  it("still answers the EMAIL mode for that same officer — the #1376 fallback", async () => {
    // They lose a convenience, not a capability: an exact address is bounded by
    // already knowing it, which is what they have always had.
    mocks.hasAdminAreaAccess.mockReturnValue(false);
    const res = await GET(request("?mode=email&email=sam%40example.com"), {
      params,
    });
    expect(res.status).toBe(200);
    expect(mocks.resolveByEmail).toHaveBeenCalledWith({
      email: "sam@example.com",
    });
  });
});

describe("what the officer's search is allowed to see", () => {
  it("declares itself an ADMIN audience rather than doctoring the settings", async () => {
    // The minors decision stays in the find service — exactly one file turns
    // either open-search value into a decision about who is discoverable. A
    // route that forced the flag itself would be a second such place.
    await GET(request("?q=whit"), { params });
    expect(mocks.searchByName).toHaveBeenCalledWith({
      q: "whit",
      settings: SETTINGS,
      audience: "ADMIN",
    });
  });
});

describe("the audit trail", () => {
  it("records a name search against the officer who typed it", async () => {
    // "Admins can see everything" is not "admin lookups need no record".
    mocks.searchByName.mockResolvedValue({
      candidates: [{ memberId: "m-1" }],
      truncated: true,
    });
    await GET(request("?q=whit"), { params });
    expect(mocks.auditSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        actorMemberId: "admin-1",
        q: "whit",
        resultCount: 1,
        truncated: true,
      }),
    );
  });

  it("records an email resolve, with the address, against the officer", async () => {
    mocks.resolveByEmail.mockResolvedValue({
      candidates: [{ memberId: "m-1" }],
    });
    await GET(request("?mode=email&email=Sam%40Example.com"), { params });
    expect(mocks.auditResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        actorMemberId: "admin-1",
        email: "sam@example.com",
        candidates: [{ memberId: "m-1" }],
      }),
    );
  });

  it("answers an empty envelope for a blank address without pretending it looked", async () => {
    // A malformed address says nothing about any member, so it gets the same
    // answer a genuine miss gets — and no query is issued.
    const res = await GET(request("?mode=email&email="), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [] });
    expect(mocks.resolveByEmail).not.toHaveBeenCalled();
  });
});
