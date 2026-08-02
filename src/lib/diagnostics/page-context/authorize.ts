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
 * Re-read the acting admin's effective permission matrix from the database.
 * Returns `null` when the member does not exist or the read fails — both of
 * which the caller must treat as a denial, not as an empty matrix it can
 * reason about.
 *
 * `canLogin` is selected because `getAdminPermissionMatrix` empties the matrix
 * for a member who cannot log in; omitting it would silently keep a deactivated
 * account's roles alive for Diagnostics.
 */
export async function readFreshAdminPermissionMatrix(
  memberId: string,
): Promise<AdminPermissionMatrix | null> {
  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: {
        canLogin: true,
        accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
      },
    });
    if (!member) return null;

    // Built WITHOUT an `adminPermissionMatrix` key on purpose: its presence
    // short-circuits derivation to the embedded (session-carried) matrix, which
    // is precisely the stale snapshot ADR-002 forbids here.
    return getAdminPermissionMatrix({
      canLogin: member.canLogin,
      accessRoles: member.accessRoles,
    });
  } catch {
    return null;
  }
}
