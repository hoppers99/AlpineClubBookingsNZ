import type { AppAccessRole } from "@/lib/access-roles";

/**
 * Session fixtures for asserting that an admin route's PER-AREA gate is real.
 *
 * ## Why these exist
 *
 * Before #2921 essentially every admin route suite signed in as `ADMIN` — which
 * holds `edit` on every area — or as `USER`, which holds nothing. A pair of
 * fixtures like that can only ever answer "is this person in the admin portal at
 * all". It cannot tell a `finance:edit` gate from a `finance:view` one, or from
 * an `overview:view` one, so a route whose declared permission is silently
 * weakened keeps a green suite. That is exactly what happened on fork PR #2949:
 * three routes were moved from `{ area: "finance", level: "edit" }` to
 * `{ area: "overview", level: "view" }` — a real privilege downgrade — and 83
 * tests still passed.
 *
 * The roles below are chosen so that a downgrade is visible in BOTH dimensions:
 *
 * - `readOnlyAdminSession` (`ADMIN_READONLY`) holds `view` on every area and
 *   `edit` on none. It pins the **level**: it must be refused by an `:edit`
 *   route and admitted by a `:view` one. Weaken `:edit` to `:view` and its
 *   denial flips to an admission.
 * - `contentAdminSession` (`ADMIN_CONTENT`) holds `content: edit` and
 *   `overview: view`, and nothing else at all. It pins the **area**: it must be
 *   refused by every route outside `content`. Re-point a route at the
 *   `overview` catch-all — the #2949 shape — and its denial flips too.
 * - `financeAdminSession` (`FINANCE_ADMIN`) and `bookingsAdminSession`
 *   (`ADMIN_BOOKINGS`) are the positive controls. A gate test built only from
 *   denials passes just as well when the route is broken shut as when it is
 *   correct, so assert at least one admission by a role that holds exactly the
 *   declared permission and no more.
 *
 * Only the roles a suite actually uses live here — the dead-code gate removes an
 * unused fixture, so add the bundle you need (they are all in
 * `ADMIN_ROLE_BUNDLES`) at the point you write the test that needs it.
 *
 * ## How to use them
 *
 * A denial needs no other setup: `requireAdmin` answers 403 before the handler
 * touches the database, so assert the status AND that the write mock was never
 * called. An admission runs the handler, so it needs whatever the suite's
 * happy-path `beforeEach` already installs.
 *
 *   it("refuses a view-only admin on the finance:edit write (#2921)", async () => {
 *     mocks.auth.mockResolvedValue(readOnlyAdminSession);
 *     const res = await POST(request());
 *     expect(res.status).toBe(403);
 *     expect(mocks.create).not.toHaveBeenCalled();
 *   });
 *
 * These fixtures deliberately carry NO `adminPermissionMatrix`. That field is
 * authoritative and short-circuits role derivation in
 * `getAdminPermissionMatrix`, so embedding one would pin the fixture instead of
 * the role bundle the deployed club actually gets. Set one explicitly in a suite
 * that is testing a custom or club-edited role definition.
 */
function sessionFor(id: string, roles: AppAccessRole[]) {
  return {
    user: {
      id,
      // `role` is the legacy single-role column. Area access is resolved from
      // `accessRoles`, so keep this at USER for anything but the full admin —
      // a fixture that says ADMIN here and something narrower below is a
      // fixture that will eventually be read the wrong way round.
      role: roles.includes("ADMIN") ? "ADMIN" : "USER",
      accessRoles: roles.map((role) => ({ role })),
    },
  };
}

/** `view` on every area, `edit` on none. Pins the level half of a requirement. */
export const readOnlyAdminSession = sessionFor("gate-readonly-admin", [
  "ADMIN_READONLY",
]);

/** `content: edit` + `overview: view` only. Pins the area half. */
export const contentAdminSession = sessionFor("gate-content-admin", [
  "ADMIN_CONTENT",
]);

/** `finance: edit`, plus `view` on bookings/membership/support/overview. */
export const financeAdminSession = sessionFor("gate-finance-admin", [
  "FINANCE_ADMIN",
]);

/**
 * `bookings: edit` and `lodge: edit`, plus `view` on membership/finance/support/
 * overview. The positive control for a `lodge:` or `bookings:` gate.
 */
export const bookingsAdminSession = sessionFor("gate-bookings-admin", [
  "ADMIN_BOOKINGS",
]);
