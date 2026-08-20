import { beforeEach, describe, expect, it, vi } from "vitest";

/*
  #2925 — the ACCESS + PAYLOAD gate on `GET /api/admin/lodges`, proved against
  the REAL guard.

  This file deliberately does NOT mock `@/lib/session-guards`. The previous
  attempt at this change (PR #2885) mocked it, passed 17/17, and shipped a route
  that still returned the exact 403 it existed to remove — because the mock's
  absent-options fallback used `hasAdminPortalAccess`, a semantic the real guard
  has never had. So everything below runs the real `requireAdmin`, the real
  `inferAdminAccessRequirement`, the real `getAdminRouteRequirement` and the real
  permission matrix, and asserts on the RESPONSE the route produced.

  The headers are the ones `src/proxy.ts` stamps on this route for real (it sets
  `x-pathname` and `x-request-method` on every request it runs on, and
  `/api/admin/lodges/:path*` is in its matcher), which is what makes the
  inference path live here rather than theoretical.
*/

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  memberFindUnique: vi.fn(),
  lodgeFindMany: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers({
      "x-pathname": "/api/admin/lodges",
      "x-request-method": "GET",
    }),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    lodge: { findMany: mocks.lodgeFindMany },
  },
}));

vi.mock("server-only", () => ({}));

import { GET } from "@/app/api/admin/lodges/route";
import { requireAdmin } from "@/lib/session-guards";
import type { AppAccessRole } from "@/lib/access-roles";

const now = new Date("2026-07-02T10:00:00.000Z");

/**
 * A full lodge row, returned by the mocked `findMany` REGARDLESS of the select
 * the route asked for.
 *
 * That is the point, and it is why the body assertions below are load-bearing
 * rather than tautological: a mock cannot enforce a `select`, so if the route's
 * serializer ever leaked a field the select was supposed to have removed, the
 * secret would be sitting right here waiting to be serialized. The select is
 * asserted separately.
 */
const FULL_LODGE_ROW = {
  id: "lodge-1",
  name: "Alpine Lodge",
  slug: "alpine-lodge",
  active: true,
  address: "12 Mountain Road, Ohakune",
  doorCode: "4821",
  travelNote: "Chains required in winter.",
  createdAt: now,
  updatedAt: now,
};

/** Sign in as a member holding exactly these access roles. */
function signInAs(...roles: AppAccessRole[]) {
  mocks.auth.mockResolvedValue({
    user: { id: "member-1", role: "ADMIN", accessRoles: roles },
  });
  mocks.memberFindUnique.mockResolvedValue({
    active: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
    accessRoles: roles.map((role) => ({
      role,
      roleDefinitionId: null,
      roleDefinition: null,
    })),
  });
}

/**
 * Sign in with a CUSTOM access-role grid rather than a shipped preset.
 *
 * Needed because no shipped preset holds `lodge` without `overview`, and that
 * combination is the one the `overview:view` gate regressed: such a caller
 * previously got the full list and would have started getting a 403. An
 * administrator can build exactly that grid on the Access Roles screen, so it is
 * reachable in a real deployment even though no preset ships it.
 */
function signInWithGrid(grid: {
  overviewLevel: "NONE" | "VIEW" | "EDIT";
  lodgeLevel: "NONE" | "VIEW" | "EDIT";
}) {
  const roleDefinition = {
    overviewLevel: grid.overviewLevel,
    bookingsLevel: "NONE",
    membershipLevel: "NONE",
    financeLevel: "NONE",
    lodgeLevel: grid.lodgeLevel,
    contentLevel: "NONE",
    supportLevel: "NONE",
  };
  mocks.auth.mockResolvedValue({
    user: { id: "member-1", role: "ADMIN", accessRoles: ["ADMIN_CUSTOM"] },
  });
  mocks.memberFindUnique.mockResolvedValue({
    active: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
    accessRoles: [
      { role: "ADMIN_CUSTOM", roleDefinitionId: "ardef_custom", roleDefinition },
    ],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.lodgeFindMany.mockResolvedValue([FULL_LODGE_ROW]);
});

/**
 * The two shipped presets the owner's decision is about. Neither holds a
 * `lodge` entry at all (`ADMIN_ROLE_BUNDLES` in `admin-permissions.ts`), so
 * before #2925 their 403 here was permanent and no retry could succeed.
 * `ADMIN_CONTENT` is the third such preset and reaches this route from the Club
 * Identity page.
 */
const PRESETS_WITHOUT_LODGE_VIEW = [
  "ADMIN_MEMBERSHIP",
  "FINANCE_ADMIN",
  "ADMIN_CONTENT",
] as const satisfies readonly AppAccessRole[];

/*
  FINANCE_USER IS DELIBERATELY NOT IN THAT LIST, and it was reviewed and decided
  rather than overlooked (#2925, 21 Aug 2026).

  Review reported it as an incomplete fix: "Finance Viewer" ships
  `overviewLevel: "NONE"` and `lodgeLevel: "NONE"`, so it is refused here while
  still reaching the finance area. Checked against the issue, that is out of
  scope: #2925 names exactly two presets, ADMIN_MEMBERSHIP and FINANCE_ADMIN,
  and its acceptance criterion asks for those two.

  It is also consistent rather than accidental. `hasAdminPortalAccess` excludes
  `finance` from what counts as portal access, which predates this issue and
  governs far more than this route. Admitting a finance-only role here would
  either contradict that or require changing it everywhere.

  Whether a finance-only viewer should read lodge names at all is a real product
  question - `getFirstAccessibleAdminHref` does send them to /admin/payments, so
  they are an admin in some sense - but it is a decision about
  `hasAdminPortalAccess`, not about this endpoint. Filed rather than absorbed.
*/

describe("GET /api/admin/lodges admits any admitted admin (#2925)", () => {
  it.each(PRESETS_WITHOUT_LODGE_VIEW)(
    "returns 200 and the lodge names to %s, which held no lodge entry and got a permanent 403",
    async (role) => {
      signInAs(role);

      const response = await GET();

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.lodges).toEqual([
        {
          id: "lodge-1",
          name: "Alpine Lodge",
          slug: "alpine-lodge",
          active: true,
        },
      ]);
    },
  );

  it.each(PRESETS_WITHOUT_LODGE_VIEW)(
    "never sends %s the door code, address or travel note — on the wire or off the database",
    async (role) => {
      signInAs(role);

      const response = await GET();
      const body = await response.json();

      // 1. The wire. Asserted on the raw JSON text as well as the parsed keys,
      //    so a value nested anywhere in the response cannot slip through.
      const [lodge] = body.lodges;
      expect(Object.keys(lodge).sort()).toEqual([
        "active",
        "id",
        "name",
        "slug",
      ]);
      expect(JSON.stringify(body)).not.toContain("4821");
      expect(JSON.stringify(body)).not.toContain("Mountain Road");
      expect(JSON.stringify(body)).not.toContain("Chains required");

      // 2. The database. The secret is never READ in the first place, which is
      //    the half a serializer cannot give you. This is the assertion that
      //    goes red if anyone plants the full select back on this branch.
      expect(mocks.lodgeFindMany).toHaveBeenCalledTimes(1);
      const select = mocks.lodgeFindMany.mock.calls[0][0].select;
      expect(Object.keys(select).sort()).toEqual([
        "active",
        "id",
        "name",
        "slug",
      ]);
      expect(select).not.toHaveProperty("doorCode");
      expect(select).not.toHaveProperty("address");
      expect(select).not.toHaveProperty("travelNote");
    },
  );

  it("still gives a lodge:view holder the whole record", async () => {
    signInAs("ADMIN");

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lodges[0]).toMatchObject({
      id: "lodge-1",
      name: "Alpine Lodge",
      slug: "alpine-lodge",
      active: true,
      address: "12 Mountain Road, Ohakune",
      doorCode: "4821",
      travelNote: "Chains required in winter.",
    });
    const select = mocks.lodgeFindMany.mock.calls[0][0].select;
    expect(select).toHaveProperty("doorCode", true);
  });

  it("gives a read-only admin the whole record too — the split is lodge:view, not edit", async () => {
    signInAs("ADMIN_READONLY");

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.lodges[0]).toHaveProperty("doorCode", "4821");
  });

  it("still refuses a caller who is not an admitted admin at all", async () => {
    signInAs("USER");

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mocks.lodgeFindMany).not.toHaveBeenCalled();
  });

  it("still refuses an anonymous caller", async () => {
    mocks.auth.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(mocks.lodgeFindMany).not.toHaveBeenCalled();
  });

  it("still refuses a deactivated admin", async () => {
    signInAs("FINANCE_ADMIN");
    mocks.memberFindUnique.mockResolvedValue({
      active: false,
      forcePasswordChange: false,
      twoFactorEnabled: false,
      accessRoles: [{ role: "FINANCE_ADMIN", roleDefinitionId: null, roleDefinition: null }],
    });

    const response = await GET();

    expect(response.status).toBe(403);
    expect(mocks.lodgeFindMany).not.toHaveBeenCalled();
  });
});

/*
  The trap that made the first attempt inert, pinned as behaviour.

  If someone "simplifies" the route back to a bare `requireAdmin()`, the tests
  above go red — but only because of what this block documents, and it is worth
  a reader being able to see it directly rather than inferring it from a
  failure. On this path, with the proxy's headers present, a bare call resolves
  to `lodge:view` by inference and refuses the very roles #2925 exists to admit.
*/
describe("the explicit permission is what opens the route, not the bare call", () => {
  it("a bare requireAdmin() on this path still resolves to lodge:view and refuses FINANCE_ADMIN", async () => {
    signInAs("FINANCE_ADMIN");

    const result = await requireAdmin();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("the explicit any-admin permission admits the same caller", async () => {
    signInAs("FINANCE_ADMIN");

    const result = await requireAdmin({ permission: "any-admin" });

    expect(result.ok).toBe(true);
  });

  it("still refuses a finance-only role, which is not portal access (#2925)", async () => {
    // Pinned so the boundary is deliberate rather than incidental.
    // `hasAdminPortalAccess` excludes `finance`, so "any-admin" does not admit a
    // finance-only grid. That predates this issue and is why FINANCE_USER is not
    // in PRESETS_WITHOUT_LODGE_VIEW above - see the note there.
    signInAs("FINANCE_USER");

    const result = await requireAdmin({ permission: "any-admin" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });

  it("any-admin does not regress lodge:view WITHOUT overview:view (#2925 review)", async () => {
    /*
      This is the test the first cut of this change lacked, and its absence was
      measured rather than guessed: with `overview:view` on the route, the whole
      suite still passed, so nothing distinguished the two gates and the
      regression was invisible.

      A custom grid holding `lodge` but not `overview` is reachable from the
      Access Roles screen. Under the old `lodge:view` gate it got the full list;
      under `overview:view` it would have started getting a 403. Under
      "any-admin" it is admitted, which is the pre-existing behaviour.
    */
    signInWithGrid({ overviewLevel: "NONE", lodgeLevel: "VIEW" });

    const viaOverview = await requireAdmin({
      permission: { area: "overview", level: "view" },
    });
    expect(
      viaOverview.ok,
      "overview:view refuses a lodge-only grid - that was the regression",
    ).toBe(false);

    const viaAnyAdmin = await requireAdmin({ permission: "any-admin" });
    expect(viaAnyAdmin.ok).toBe(true);
  });

  it("and such a caller still gets the FULL record, because it holds lodge:view", async () => {
    signInWithGrid({ overviewLevel: "NONE", lodgeLevel: "VIEW" });

    const response = await GET();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.lodges[0]).toMatchObject({
      doorCode: "4821",
      address: "12 Mountain Road, Ohakune",
    });
  });

  it("permission: false is not 'any admitted admin' either — it falls back to the literal ADMIN role", async () => {
    signInAs("FINANCE_ADMIN");

    const result = await requireAdmin({ permission: false });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });
});
