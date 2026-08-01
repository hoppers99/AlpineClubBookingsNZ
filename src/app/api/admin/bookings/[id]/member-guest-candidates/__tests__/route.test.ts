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

import {
  GET,
  POST,
} from "@/app/api/admin/bookings/[id]/member-guest-candidates/route";

const SETTINGS = {
  approvalRequired: true,
  pendingHoldExpiryDays: 7,
  openMemberSearchEnabled: false,
  openMemberSearchIncludesMinors: false,
};

const ROUTE_URL =
  "https://club.example.org/api/admin/bookings/bk-1/member-guest-candidates";

function request(query: string) {
  return new NextRequest(`${ROUTE_URL}${query}`);
}

/**
 * The EMAIL mode's request — a POST with the address in the BODY.
 *
 * The method is the assertion, not the plumbing: a GET would have put another
 * member's address into the access log, the browser history and the `Referer` of
 * every later request from the page, which is precisely why the member-facing
 * twin is a POST and calls the choice load-bearing in its own docblock.
 */
function emailRequest(body: unknown) {
  return new NextRequest(ROUTE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
    const res = await POST(emailRequest({ email: "sam@example.com" }), {
      params,
    });
    expect(res.status).toBe(200);
    expect(mocks.resolveByEmail).toHaveBeenCalledWith({
      email: "sam@example.com",
    });
  });

  it("does not exist at all on the EMAIL mode either when the module is off", async () => {
    mocks.loadMemberGuestFindGate.mockResolvedValue({ ok: false });
    const res = await POST(emailRequest({ email: "sam@example.com" }), { params });
    expect(res.status).toBe(404);
    expect(mocks.resolveByEmail).not.toHaveBeenCalled();
  });
});

describe("the address never travels in the URL", () => {
  it("takes the email from the BODY, and the route exposes no GET email mode", async () => {
    // The regression this pins is a whole-route one rather than a line: the
    // first cut read `?mode=email&email=…` from the query string, which put a
    // member's address into the access log and the browser history. A GET now
    // has one mode only, and it is the name search.
    await POST(emailRequest({ email: "sam@example.com" }), { params });
    expect(mocks.resolveByEmail).toHaveBeenCalledWith({
      email: "sam@example.com",
    });

    mocks.resolveByEmail.mockClear();
    await GET(request("?mode=email&email=sam%40example.com"), { params });
    // The GET fell through to the NAME search — it did not resolve an address.
    expect(mocks.resolveByEmail).not.toHaveBeenCalled();
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
    await POST(emailRequest({ email: "Sam@Example.com" }), { params });
    expect(mocks.auditResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        actorMemberId: "admin-1",
        email: "sam@example.com",
        candidates: [{ memberId: "m-1" }],
      }),
    );
  });

  it("answers an empty envelope for a blank address — and STILL records it", async () => {
    // Two properties in one, and the second is D-20 rider (b). The caller must
    // not be able to tell a malformed address from a genuine miss, so the
    // response is identical and no query is issued. But indistinguishable to
    // the caller is not invisible to the club: the member route audits this
    // case as `outcome: "failure"` precisely so a run of malformed probes is
    // findable, and rider (b) says an admin resolve is audited identically. It
    // was the one outcome on this route that left no trace at all.
    const res = await POST(emailRequest({ email: "   " }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [] });
    expect(mocks.resolveByEmail).not.toHaveBeenCalled();
    expect(mocks.auditResolve).toHaveBeenCalledWith(
      expect.objectContaining({ actorMemberId: "admin-1", outcome: "failure" }),
    );
  });

  it("records the attempt even when the lookup itself throws", async () => {
    // The envelope hides the failure from the caller (a 500 on the "member
    // exists" path and a 200 on the "does not" path would be the crudest
    // possible oracle), which is exactly why the row has to exist: without it
    // the trail would show nothing at all for the class of request most worth
    // being able to find later.
    mocks.resolveByEmail.mockRejectedValue(new Error("boom"));
    const res = await POST(emailRequest({ email: "sam@example.com" }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [] });
    expect(mocks.auditResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        actorMemberId: "admin-1",
        email: "sam@example.com",
        outcome: "failure",
      }),
    );
  });
});
