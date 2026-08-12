/**
 * TIERED READINESS (AID-7, #2378; owner decision Q6).
 *
 * Two audiences, one source of truth. Every admitted administrator may open the
 * Diagnostics workspace and must be able to tell whether it is usable and who can
 * fix it if not — otherwise the page is a dead end that explains nothing. But the
 * DETAIL of why it is not ready is operational: the verified privilege state of the
 * dedicated database role, the stored-credential state, the configured spend. That
 * stays behind `support:view`.
 *
 * WHY THE SPLIT IS COMPUTED ON THE SERVER AND NOT IN THE COMPONENT. The coarse tier
 * is not the detailed tier with fields hidden by CSS or by a conditional render — a
 * field that reaches the browser is disclosed, whatever the markup does with it. So
 * the narrow shape is BUILT here from the full verdict, and the full verdict never
 * leaves the server for a caller who has not earned it. `readinessForAdmin` returns
 * one or the other, never both, and the two shapes are different types so a
 * component cannot accidentally read a field it was not given.
 *
 * WHAT THE COARSE TIER DELIBERATELY SAYS. Enough to act on and nothing more:
 * whether diagnostics is usable, and who to ask. It does NOT say which gate failed,
 * because "the database role is missing its SELECT grant" tells an administrator
 * without support access something about the deployment's internals that they
 * cannot act on and did not need. `whoCanResolve` is the honest substitute — the
 * question they actually have is not "what is broken" but "who do I ask".
 *
 * IT NEVER CLAIMS MORE THAN THE VERDICT DOES. `ready` is fail-closed upstream: any
 * resolution fault returns not-ready. This module only ever narrows that answer, so
 * a coarse "not ready" can never be produced from a full "ready", and there is no
 * path here that can invent readiness the server did not establish.
 */

import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { DiagnosticsReadiness } from "@/lib/ai-diagnostics-config";

/** What every admitted admin may see. Deliberately small. */
export interface CoarseDiagnosticsReadiness {
  tier: "coarse";
  /** Usable right now? Narrowed from the fail-closed verdict, never widened. */
  ready: boolean;
  /**
   * Whether the club has switched the module on. Included because it is the one
   * blocker an ordinary admin may be able to act on themselves, and because
   * "diagnostics is off" is not an internal detail — it is a club setting.
   *
   * It carries the verdict's own value UNCHANGED, including the `null` that #2803
   * introduces for "the setting could not be read". A consumer must render that as
   * "could not check" — never as off, and never as a prompt to switch it on.
   */
  moduleEnabled: DiagnosticsReadiness["moduleEnabled"];
  /** Who to ask, in plain words. The question a coarse reader actually has. */
  whoCanResolve: string;
}

/** What a support-capable admin may see: the whole verdict, unchanged. */
export interface DetailedDiagnosticsReadiness extends DiagnosticsReadiness {
  tier: "detailed";
}

export type TieredDiagnosticsReadiness =
  | CoarseDiagnosticsReadiness
  | DetailedDiagnosticsReadiness;

/**
 * The one sentence a coarse reader gets instead of the blocker list.
 *
 * Split by whether they can act on it themselves: the module switch lives in
 * Admin > Modules and an admin with content/settings reach may simply turn it on,
 * whereas a credential, a budget or a database role is a deployment matter. Saying
 * "ask an administrator with support access" to somebody who only needed to flip a
 * switch would be wrong in the annoying direction.
 */
function whoCanResolve(readiness: DiagnosticsReadiness): string {
  if (readiness.ready) return "AI Diagnostics is set up and ready to use.";

  // `=== false`, NOT `!moduleEnabled` — and this is the whole point of the branch.
  // #2803 makes `moduleEnabled` tri-state: `true`, `false`, or `null` meaning the
  // club's module setting could not be READ. A falsy test would fold `null` in with
  // `false` and tell an operator the module is switched off when the truthful answer
  // is "we could not check", sending them to turn on something that may already be
  // on. That is precisely the misreport #2803 exists to remove, and it would have
  // been reintroduced here, one layer above the fix.
  //
  // Written this way BEFORE #2803 merges, so the tri-state cannot arrive and quietly
  // find a falsy test waiting for it.
  if (readiness.moduleEnabled === false) {
    return "AI Diagnostics is switched off for this club. Someone who can manage Feature modules can turn it on.";
  }
  return "AI Diagnostics is not ready yet. Someone with support access can see what is still needed and finish the setup.";
}

/**
 * Narrow a readiness verdict to what this administrator may see.
 *
 * The permission is read from the caller's freshly-resolved matrix, never from
 * anything the client sent — the same rule every tool invocation follows.
 */
export function readinessForAdmin(
  readiness: DiagnosticsReadiness,
  matrix: AdminPermissionMatrix,
): TieredDiagnosticsReadiness {
  // Read straight off the resolved matrix. `hasAdminAreaAccess` takes a member-ish
  // input and re-derives, which is the right shape where a member is in hand — here
  // the matrix has ALREADY been resolved once by the layout guard, and re-deriving
  // from a synthetic input would be a second derivation that could disagree with the
  // first. `edit` implies `view`, hence both.
  const support = matrix.support;
  const canSeeDetail = support === "view" || support === "edit";

  if (canSeeDetail) return { tier: "detailed", ...readiness };

  return {
    tier: "coarse",
    ready: readiness.ready,
    moduleEnabled: readiness.moduleEnabled,
    whoCanResolve: whoCanResolve(readiness),
  };
}
