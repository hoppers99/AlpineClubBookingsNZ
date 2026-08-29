import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

/*
  A whole-client stand-in, the same shape as
  `setup-readiness-db-module-settings.test.ts` and the readiness-snapshot suite
  in `club-time-zone-backfill.test.ts`: every delegate answers with the empty
  shape its caller already tolerates, except `member.count`, which is a real spy
  so the `where` it is given can be read back.
*/
const { memberCount, mockPrisma } = vi.hoisted(() => {
  const memberCount = vi.fn(async () => 0);
  const emptyDelegate = new Proxy(
    {},
    {
      get: (_target, method: string) => {
        if (method === "count") return async () => 0;
        if (method === "findMany") return async () => [];
        return async () => null;
      },
    },
  );
  const mockPrisma = new Proxy(
    {},
    {
      get: (_target, model: string) =>
        model === "member" ? { count: memberCount } : emptyDelegate,
    },
  );
  return { memberCount, mockPrisma };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/lodge-capacity")>()),
  getDefaultLodgeCapacity: vi.fn(async () => 12),
}));
vi.mock("@/lib/stripe-config", () => ({
  getStripeSetupState: vi.fn(async () => ({
    secretKeySet: false,
    publishableKeySet: false,
    webhookSecretSet: false,
    needsReentry: false,
  })),
}));
vi.mock("@/lib/xero-token-store", () => ({
  getXeroTokenReadability: vi.fn(async () => "readable"),
}));

import { legacyRoleFromAccessRoles } from "@/lib/access-roles";
import { getSetupDatabaseSnapshot } from "@/lib/setup-readiness-db";

/**
 * WHAT `adminCount` COUNTS, and why C20 (#251) pins it here.
 *
 * The `seed-admin` step is `complete` when `adminCount > 0` and `blocked`
 * otherwise, and `adminCount` is a count of the LEGACY `role` column. Modern
 * authorisation is `accessRoles` tokens, and the two are not the same field —
 * so the wizard's new create-an-administrator pane can grant working admin
 * access and leave this count at zero, with nothing anywhere reporting a
 * failure. The operator does the work and the step stays amber.
 *
 * What keeps them in step is a DERIVATION, not a coincidence:
 * `createAdminMember` (and the member edit path, and the edit-group builder)
 * set the legacy column from the token set with `legacyRoleFromAccessRoles`.
 * So the property this file pins is the JOIN between the two halves — the value
 * the count filters on, and the value the pane's token set derives to. The
 * pane's half is pinned in
 * `src/app/(admin)/admin/setup/wizard/__tests__/setup-wizard-first-admin-pane.test.tsx`.
 *
 * Read against the real snapshot builder rather than by grepping the source, so
 * a rewrite of that query that quietly changed the filter — to `role: "USER"`,
 * or by dropping the `active` scope — fails here.
 */
describe("the First Admin step's count", () => {
  it("counts ACTIVE members holding the legacy ADMIN role", async () => {
    memberCount.mockClear();

    const snapshot = await getSetupDatabaseSnapshot();

    expect(snapshot.adminCount).toBe(0);
    expect(memberCount).toHaveBeenCalledTimes(1);
    expect(memberCount.mock.calls[0][0]).toEqual({
      where: { role: "ADMIN", active: true },
    });
  });

  it("is reached by the access-role token the wizard's pane grants", () => {
    /*
      The other end of the same chain, asserted through the real derivation. A
      SCOPED admin bundle is included on purpose: it is a perfectly good
      administrator by every modern check and it does NOT move this count, which
      is exactly the trap the pane has to avoid — and the reason the pane grants
      the Full Admin token rather than a narrower one.
    */
    expect(legacyRoleFromAccessRoles(["ADMIN"])).toBe("ADMIN");
    expect(legacyRoleFromAccessRoles(["ADMIN_MEMBERSHIP"])).toBe("USER");
    expect(legacyRoleFromAccessRoles([])).toBe("USER");
  });
});
