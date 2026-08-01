import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * #2314, owner decision 2 Aug 2026: the organisation short-code endpoint is
 * **finance-admin-only**. Only an admin holding the finance area may read it,
 * matching the audience of the Xero deep links the short code feeds. Widening it
 * to any admin who can view settings was considered and declined — it grows the
 * surface for no current feature need, and an admin who cannot read this route
 * still sees every deep link, just unqualified.
 *
 * This exercises the REAL `requireAdmin`, not a stub of it. Asserting that the
 * route passes `{ area: "finance", level: "view" }` would pass just as happily
 * if the permission matrix stopped honouring it, and the point of the decision
 * is who actually gets a 403.
 *
 * Both request-plumbing states are covered, because the route's explicit
 * requirement is a change of mechanism rather than of audience. When
 * `src/proxy.ts` has stamped the served path, `requireAdmin` would infer
 * finance from `/api/admin/xero` anyway and the two agree — that agreement is
 * what stops the route and the route-area map drifting apart. When the header is
 * absent, inference yields nothing and the fallback is Full Admin only, so
 * without the explicit requirement a legitimate finance viewer is shut out.
 * Naming it here makes the answer the same either way.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  memberFindUnique: vi.fn(),
  getXeroConnectedOrganisation: vi.fn(),
  /** What `src/proxy.ts` stamped on the request, or null for "no header". */
  requestPath: { value: null as string | null },
}));

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(
      mocks.requestPath.value
        ? { "x-pathname": mocks.requestPath.value }
        : {},
    ),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));

vi.mock("@/lib/prisma", () => ({
  prisma: { member: { findUnique: mocks.memberFindUnique } },
}));

vi.mock("@/lib/xero-organisation", () => ({
  getXeroConnectedOrganisation: mocks.getXeroConnectedOrganisation,
}));

import { GET } from "@/app/api/admin/xero/organisation/route";

function signedInAs(accessRoles: string[]) {
  mocks.auth.mockResolvedValue({ user: { id: "member-1" } });
  mocks.memberFindUnique.mockResolvedValue({
    active: true,
    forcePasswordChange: false,
    twoFactorEnabled: false,
    accessRoles: accessRoles.map((role) => ({ role, roleDefinition: null })),
  });
}

function request() {
  return new NextRequest("https://club.example.org/api/admin/xero/organisation");
}

/** The two request-plumbing states: proxy header stamped, and not. */
const PLUMBING = [
  ["with the served path stamped", "/api/admin/xero/organisation"],
  ["with no served path stamped", null],
] as const;

describe.each(PLUMBING)(
  "GET /api/admin/xero/organisation authorisation (#2314) %s",
  (_label, headerPath) => {
    beforeEach(() => {
      vi.clearAllMocks();
      mocks.requestPath.value = headerPath;
      mocks.getXeroConnectedOrganisation.mockResolvedValue({
        name: "Alpine Club",
        financialYearEndMonth: 3,
        shortCode: "!aBc12",
        readFailure: null,
      });
    });

    it("refuses an admin who has no finance access", async () => {
      // A content editor: a real admin with real admin access, who has no
      // business with the club's books (overview:view + content:edit, and
      // nothing else).
      signedInAs(["ADMIN_CONTENT"]);

      const res = await GET(request());

      expect(res.status).toBe(403);
      await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
      // The refusal happens before Xero is touched at all.
      expect(mocks.getXeroConnectedOrganisation).not.toHaveBeenCalled();
    });

    it("refuses a member with no admin access at all", async () => {
      signedInAs(["USER"]);

      const res = await GET(request());

      expect(res.status).toBe(403);
      expect(mocks.getXeroConnectedOrganisation).not.toHaveBeenCalled();
    });

    // Worth stating plainly, because "finance-admin-only" could be read as "only
    // the finance officers": the gate is HOLDING THE FINANCE AREA, and the
    // seeded bookings and membership bundles carry `finance: view` by default.
    // Those admins already see the Xero deep links on the pages they work in, so
    // admitting them is the decision working as written, not a leak. A club that
    // narrows either definition below finance:view takes their access away here
    // too, which is the right coupling.
    it.each(["ADMIN_BOOKINGS", "ADMIN_MEMBERSHIP", "ADMIN_READONLY"])(
      "allows %s, which holds finance:view under the seeded bundles",
      async (role) => {
        signedInAs([role]);

        expect((await GET(request())).status).toBe(200);
      },
    );

    it("allows a finance viewer", async () => {
      // View is the level a READ asks for; a finance user who can see the books
      // but not change them still needs their deep links to land in the right
      // organisation. Without the route's own requirement this case is a 403
      // whenever the served path is not stamped.
      signedInAs(["FINANCE_USER"]);

      const res = await GET(request());

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ shortCode: "!aBc12" });
    });

    it.each(["FINANCE_ADMIN", "ADMIN"])("allows %s", async (role) => {
      signedInAs([role]);

      expect((await GET(request())).status).toBe(200);
    });

    // #2404: on a MODULE-GATED path an anonymous caller gets the module gate's
    // own frozen 404 rather than a 401, so one unauthenticated request cannot
    // read whether the Xero module is switched on. That branch only fires when
    // the served path is known, which is why the expectation follows the
    // plumbing rather than being pinned to one value.
    it("refuses an anonymous caller without disclosing the module state", async () => {
      mocks.auth.mockResolvedValue(null);

      const res = await GET(request());

      expect(res.status).toBe(headerPath ? 404 : 401);
      expect(mocks.getXeroConnectedOrganisation).not.toHaveBeenCalled();
    });
  },
);
