/**
 * AI Diagnostics — fresh, fail-closed authorization for page context (AID-4,
 * #2373; contract in ADR-002).
 *
 * TWO PROPERTIES, BOTH LOAD-BEARING:
 *
 *  1. FRESH. The caller's effective permission matrix is re-read from the
 *     database-joined access roles on EVERY resolution — exactly as
 *     `resolveEffectiveSurface` does in `/api/help/chat` — never from the JWT,
 *     the session, or a cached matrix. A role revoked mid-session must take
 *     effect on the very next question, and a stale token must never widen what
 *     the assistant can re-fetch. There is deliberately no memo here: caching is
 *     the whole defect this exists to avoid.
 *
 *  2. AND, NOT OR. A page that reads two areas needs `view` on BOTH. A caller
 *     holding one of them gets a denial plus an explicit omission notice naming
 *     the area they lack, never a widened read and never a silent partial.
 *
 * Any fault reading the roles denies. "We could not establish what you may see"
 * resolves to "you see nothing", never to the previous answer.
 *
 * ACCOUNT STATE IS PART OF THE READ, not something the caller is trusted to have
 * checked. `requireAdmin` refuses a member whose account is deactivated or under
 * a forced password change, so this gate refuses the same states from the same
 * freshly-read row — otherwise a session that is still holding a cookie would
 * keep full page-context access on an account every other admin surface has
 * already locked out.
 */

import "server-only";

import { MEMBER_ACCESS_ROLE_SELECT } from "@/lib/access-role-definitions";
import {
  getAdminPermissionMatrix,
  type AdminPermissionArea,
  type AdminPermissionMatrix,
} from "@/lib/admin-permissions";
import { prisma } from "@/lib/prisma";

/**
 * `view` or better on EVERY listed area. An empty list returns `false`: a route
 * that requires nothing would be a route anyone may read, which the registry
 * forbids and this refuses to implement as a fallback.
 */
export function hasAllAreaViews(
  matrix: AdminPermissionMatrix,
  areas: readonly AdminPermissionArea[],
): boolean {
  if (areas.length === 0) return false;
  return areas.every((area) => matrix[area] !== "none");
}

/** The areas from `required` the matrix does NOT grant at `view`, in order. */
export function missingAreaViews(
  matrix: AdminPermissionMatrix,
  areas: readonly AdminPermissionArea[],
): AdminPermissionArea[] {
  return areas.filter((area) => matrix[area] === "none");
}

/**
 * Why a fresh matrix read produced no matrix. All three deny, and none is ever an
 * empty matrix the caller can reason about — but they are DIFFERENT operational
 * events: a database outage, an authorization anomaly (a stale or forged acting
 * member id) and an ordinary account lock-out.
 *
 * WHERE THAT DISTINCTION LIVES — AND WHERE IT DOES NOT. It is carried on the
 * resolved context's `reason` (`actor_read_failed` / `actor_unresolved` /
 * `actor_blocked`), which is the caller's to act on, and it is disclosed to the
 * model in the rendered evidence block. It is NOT in the audit row: ADR-004 §4's
 * approved metadata list is closed and carries no failure-reason field, so
 * `DiagnosticsPageContextAudit` has none and all three actor failures produce
 * BYTE-IDENTICAL audit objects. That is deliberate rather than an oversight —
 * widening the list is an ADR-004 amendment and an owner decision — so anything
 * triaging these incidents apart must read the resolved context, never the row
 * alone.
 *
 * `member_blocked` covers the account-state levers that lock an admin out of the
 * rest of the admin surface: `active === false` (what the members screen's
 * deactivate action writes) and `forcePasswordChange === true`. They share one
 * code because they are one operational class — a legitimate, administrator-driven
 * lock-out with no triage difference — unlike the outage/anomaly split above.
 */
export type FreshAdminPermissionMatrixFailure =
  | "member_not_found"
  | "member_blocked"
  | "read_failed";

export type FreshAdminPermissionMatrixResult =
  | { ok: true; matrix: AdminPermissionMatrix }
  | { ok: false; failure: FreshAdminPermissionMatrixFailure };

/**
 * Re-read the acting admin's effective permission matrix from the database.
 * Never throws: a missing member, a locked-out account and a failed read all come
 * back as a typed refusal the caller must treat as a denial.
 *
 * WHY THREE ACCOUNT-STATE COLUMNS, not just the roles:
 *
 *  - `active` is the platform's actual revocation lever. `requireAdmin` refuses
 *    `!member.active` with 403 "Account is deactivated", and the members screen's
 *    deactivate action writes `active: false` and leaves `canLogin` untouched. A
 *    gate that read only `canLogin` would leave a just-deactivated admin with full
 *    page-context access while every other admin surface already refuses them.
 *  - `forcePasswordChange` is refused by `requireAdmin` for the same reason, so an
 *    account that cannot open an admin page cannot re-read one through here either.
 *  - `canLogin` is selected because `getAdminPermissionMatrix` empties the matrix
 *    for a member who cannot log in — archive and membership cancellation clear it
 *    — so omitting it would hand that derivation a wider input than it should get.
 *
 * NOT COVERED, deliberately: the two-factor gate. `isTwoFactorSessionBlocked`
 * decides on SESSION facts (`twoFactorRequired` / `twoFactorVerified`) that no
 * member row carries, and this module takes a member id precisely so it cannot be
 * handed a session to trust. That check therefore stays where it can be made
 * honestly — `requireAdmin`, on the route AID-7 (#2378) builds.
 */
export async function readFreshAdminPermissionMatrix(
  memberId: string,
): Promise<FreshAdminPermissionMatrixResult> {
  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: {
        active: true,
        canLogin: true,
        forcePasswordChange: true,
        accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
      },
    });
    if (!member) return { ok: false, failure: "member_not_found" };
    if (!member.active || member.forcePasswordChange) {
      return { ok: false, failure: "member_blocked" };
    }

    // Built WITHOUT an `adminPermissionMatrix` key on purpose: its presence
    // short-circuits derivation to the embedded (session-carried) matrix, which
    // is precisely the stale snapshot ADR-002 forbids here.
    return {
      ok: true,
      matrix: getAdminPermissionMatrix({
        canLogin: member.canLogin,
        accessRoles: member.accessRoles,
      }),
    };
  } catch {
    return { ok: false, failure: "read_failed" };
  }
}
