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

  it("the explicit overview:view requirement admits the same caller", async () => {
    signInAs("FINANCE_ADMIN");

    const result = await requireAdmin({
      permission: { area: "overview", level: "view" },
    });

    expect(result.ok).toBe(true);
  });

  it("permission: false is not 'any admitted admin' either — it falls back to the literal ADMIN role", async () => {
    signInAs("FINANCE_ADMIN");

    const result = await requireAdmin({ permission: false });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });
});
