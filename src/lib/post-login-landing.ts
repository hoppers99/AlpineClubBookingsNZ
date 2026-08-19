import type { PostLoginLanding } from "@prisma/client";
import { DEFAULT_POST_LOGIN_PATH, getExplicitCallbackUrl } from "@/lib/auth-redirect";
import { getFamilyInviteReturnPath } from "@/lib/family-invite-return-address";
import {
  getFirstAccessibleAdminHref,
  type AdminPermissionInput,
} from "@/lib/admin-permissions";

/**
 * Resolve where a member lands after authentication (#2090).
 *
 * Precedence, highest first:
 *   1. A genuinely explicit (user/deep-link-supplied) safe `callbackUrl` — it
 *      always wins, over both the preference and the role default (D-D4). A
 *      value the login flow itself materialised (the 2FA detour, a provider
 *      callbackUrl) must NOT be passed in as `explicitCallbackUrl`, so it never
 *      counts as explicit here.
 *   2. A family-invite return address carried server-side in the #2827 cookie —
 *      an explicit deep link the visitor asked for by clicking "I already have
 *      an account" on `/family-invite/<token>`, which is carried privately
 *      rather than in a `callbackUrl` because putting it in the URL means
 *      rendering the invite token into a link's `href` on a page that injects
 *      admin Raw CSS. It sits BELOW an explicit `callbackUrl`, so a member who
 *      was bounced out of a member page still returns to that page, and the
 *      invite cookie simply expires. See
 *      `src/lib/family-invite-return-address.ts`.
 *   3. An explicit MEMBER_DASHBOARD preference — pins /dashboard even for a
 *      member with admin access.
 *   4. Everything else — an ADMIN_DASHBOARD preference AND the null role
 *      default — resolves to `getFirstAccessibleAdminHref(matrix) ?? "/dashboard"`,
 *      NOT a literal /admin/dashboard: an admin's matrix can deny the overview
 *      area while allowing other admin pages (D-D3). A plain member's matrix
 *      grants no admin area, so this is /dashboard; a demoted admin holding a
 *      stale ADMIN_DASHBOARD preference likewise falls through to /dashboard —
 *      the same safe target the admin-layout guard bounces to, never a 403 loop.
 *
 * `privateReturnPath` is re-validated HERE rather than trusted from the caller,
 * so a site that forwards a raw cookie value cannot turn this function into an
 * open redirect or a general "land anywhere" lever: the only value it can ever
 * return from that input is a `/family-invite/<token>` page.
 */
export function resolvePostLoginLandingPath(args: {
  explicitCallbackUrl?: string | null;
  privateReturnPath?: string | null;
  landingPreference?: PostLoginLanding | null;
  permissionInput: AdminPermissionInput;
}): string {
  const explicit = getExplicitCallbackUrl(args.explicitCallbackUrl);
  if (explicit) {
    return explicit;
  }

  const privateReturn = getFamilyInviteReturnPath(args.privateReturnPath);
  if (privateReturn) {
    return privateReturn;
  }

  if (args.landingPreference === "MEMBER_DASHBOARD") {
    return DEFAULT_POST_LOGIN_PATH;
  }

  return (
    getFirstAccessibleAdminHref(args.permissionInput) ?? DEFAULT_POST_LOGIN_PATH
  );
}
