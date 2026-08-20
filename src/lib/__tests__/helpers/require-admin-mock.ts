import { NextResponse } from "next/server";
import {
  hasAdminAreaAccess,
  hasAdminPortalAccess,
  type AdminAccessRequirement,
} from "@/lib/admin-permissions";

export type RequireAdminMockOptions = {
  permission?: AdminAccessRequirement | false;
};

/**
 * Drop-in `requireAdmin` implementation for tests that mock
 * "@/lib/session-guards". Mirrors the real guard's 401/403 semantics but
 * delegates to the test's mocked `auth()` and `requireActiveSessionUser()`
 * so per-test session and active-member setups keep working.
 *
 * ## Wire it in like this — the direct reference, with no wrapper
 *
 *   vi.mock("@/lib/session-guards", async () => ({
 *     requireAdmin: (await import("./helpers/require-admin-mock"))
 *       .evaluateRequireAdminMock,
 *     requireActiveSessionUser: mocks.requireActiveSessionUser,
 *   }));
 *
 * Note the `async` factory and the **bare function reference**. Do not wrap it
 * in an arrow that re-invokes it — see the hazard below. If a file genuinely
 * needs a wrapper (a `vi.fn()` spy whose implementation is set later), the
 * wrapper MUST forward its own first parameter:
 *
 *   mockRequireAdmin.mockImplementation(async (options) =>
 *     (await import("./helpers/require-admin-mock"))
 *       .evaluateRequireAdminMock(options),
 *   );
 *
 * ## The hazard this helper has already caused (#2921)
 *
 * The route under test tells the guard which area and level it wants, by
 * passing `{ permission: { area, level } }`. This mock can only honour that if
 * the value reaches it. A wrapper that takes no parameter —
 *
 *   requireAdmin: async () => (await import(...)).evaluateRequireAdminMock(),
 *
 * — silently throws that away. With no requirement the branch below falls back
 * to `hasAdminPortalAccess`, i.e. "is this person in the admin portal at all",
 * a check the REAL guard has never performed. Every per-area assertion in such
 * a file is then vacuous: a `lodge:view`-gated route and a `lodge:edit`-gated
 * one are indistinguishable, and a test asserting that an edit-level action is
 * refused to a view-only role passes without ever exercising the rule.
 *
 * That was not theoretical. It was found in `admin-lodges-route.test.ts` when
 * the defect the new tests targeted was planted back and they stayed green, and
 * the sweep that followed found the same hole in 50 more files.
 *
 * Two controls now stop it coming back, and both are deliberate:
 *
 * 1. **`options` is a required parameter** (it accepts `undefined`, because a
 *    route that passes nothing is legitimate — but you must pass *something*).
 *    So `evaluateRequireAdminMock()` is a compile error, not a silent
 *    downgrade, and `npm run typecheck` fails the build on it.
 * 2. **`require-admin-mock-forwarding-contract.test.ts`** parses every test
 *    file that mentions this helper and fails when a call does not forward its
 *    enclosing function's own first parameter — which is the shape the type
 *    system cannot see (`evaluateRequireAdminMock({})` compiles fine and is
 *    just as inert).
 *
 * Passing `{ permission: false }` is the one legitimate way to ask for the
 * broad portal check, and it is explicit at the call site so a reviewer sees it.
 */
export async function evaluateRequireAdminMock(
  options: RequireAdminMockOptions | undefined,
) {
  const { auth } = await import("@/lib/auth");
  const session = await auth();
  if (!session?.user?.id) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  const permission = options?.permission;
  const requirement = permission === false ? null : (permission ?? null);
  const hasAccess = requirement
    ? hasAdminAreaAccess(session.user, requirement)
    : hasAdminPortalAccess(session.user);
  if (!hasAccess) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  const { requireActiveSessionUser } = await import("@/lib/session-guards");
  const inactive = await requireActiveSessionUser(session.user.id);
  if (inactive) {
    return { ok: false as const, response: inactive };
  }
  return { ok: true as const, session };
}
