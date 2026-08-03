/**
 * AI Diagnostics — fresh, fail-closed authorization for a TOOL invocation
 * (AID-5, #2374; contract in ADR-002 §2/§3).
 *
 * This deliberately reuses AID-4's `readFreshAdminPermissionMatrix` rather than
 * re-implementing it. There must be exactly ONE function in the codebase that
 * re-reads an acting admin's effective matrix for Diagnostics: the property that
 * matters (no JWT, no session snapshot, no memo, deactivated accounts emptied) is
 * subtle enough that a second copy would eventually drift from the first, and the
 * drifted copy would be the one that quietly widened access. The page-context
 * module owns the reader; this module owns the tool-shaped verdict.
 *
 * TWO PROPERTIES, BOTH LOAD-BEARING:
 *
 *  1. FRESH ON EVERY INVOCATION — not once per session, and never cached across
 *     tool calls. A role revoked mid-session must take effect on the very next
 *     tool call, and round two of a multi-tool loop is authorized exactly as
 *     strictly as round one.
 *  2. AND, NOT OR — a tool that reads two areas needs `view` on BOTH. The caller
 *     gets a denial naming the areas they lack, never a widened read and never a
 *     silent partial.
 *
 * WITHHOLDING A DEFINITION IS NOT AUTHORIZATION. `definitions.ts` hides tools the
 * caller cannot use from the model, purely so the model does not offer an
 * operator something they will be refused. This check runs on every invocation
 * regardless of whether the definition was ever offered — an invocation naming a
 * withheld tool id is authorized here and denied here.
 */

import "server-only";

import type {
  AdminPermissionArea,
  AdminPermissionMatrix,
} from "@/lib/admin-permissions";

import {
  hasAllAreaViews,
  missingAreaViews,
  readFreshAdminPermissionMatrix,
  type FreshAdminPermissionMatrixFailure,
} from "../page-context/authorize";

export type DiagnosticsToolAuthorization =
  | { ok: true; matrix: AdminPermissionMatrix }
  | {
      ok: false;
      reason:
        | "actor_unresolved"
        | "actor_blocked"
        | "actor_read_failed"
        | "permission_denied";
      /** Populated only for `permission_denied`; empty otherwise. */
      missingAreas: AdminPermissionArea[];
    };

/**
 * Every way the fresh actor read can fail, mapped to the reason it reports. A
 * TOTAL `Record` on purpose, and identical in shape to AID-4's own map in
 * `page-context/resolve.ts`: a new failure code cannot compile until somebody has
 * given it a reason. The ternary this replaced had a fallback, so
 * `member_blocked` — an administratively locked-out admin — was filed as
 * `actor_read_failed`, which the reference guide defines as a database fault and
 * whose operator sentence invites a retry. One cause must not produce two
 * different verdicts across the two evidence channels.
 */
const ACTOR_FAILURE_REASON: Record<
  FreshAdminPermissionMatrixFailure,
  "actor_unresolved" | "actor_blocked" | "actor_read_failed"
> = {
  member_not_found: "actor_unresolved",
  member_blocked: "actor_blocked",
  read_failed: "actor_read_failed",
};

/**
 * Authorize one tool invocation. Never throws: an unresolvable actor, a locked-out
 * actor and an unreadable role set are typed refusals the caller must treat as
 * denials, and all three stay DISTINCT so a database outage, a deactivated account
 * and an authorization anomaly (a stale or forged acting member id) are not the
 * same audit row.
 *
 * An empty `requiredAreas` denies, because `hasAllAreaViews` refuses an empty
 * list: a tool that requires nothing would be a tool anyone may run, which the
 * registry contract forbids and this refuses to implement as a fallback.
 */
export async function authorizeDiagnosticsToolCall(input: {
  actingMemberId: string;
  requiredAreas: readonly AdminPermissionArea[];
}): Promise<DiagnosticsToolAuthorization> {
  // `readFreshAdminPermissionMatrix` catches its own database faults and returns a
  // typed failure, so this guard should be unreachable. It is here anyway because
  // "never throws" is THIS function's contract, and inheriting it from a
  // collaborator makes it a property of the other module's current implementation
  // rather than of this one. A throw here would surface as `internal_error` and
  // lose the distinction between an unresolvable actor and an unreadable role set.
  let fresh: Awaited<ReturnType<typeof readFreshAdminPermissionMatrix>>;
  try {
    fresh = await readFreshAdminPermissionMatrix(input.actingMemberId);
  } catch {
    return { ok: false, reason: "actor_read_failed", missingAreas: [] };
  }
  if (!fresh.ok) {
    return {
      ok: false,
      reason: ACTOR_FAILURE_REASON[fresh.failure],
      missingAreas: [],
    };
  }

  if (!hasAllAreaViews(fresh.matrix, input.requiredAreas)) {
    return {
      ok: false,
      reason: "permission_denied",
      // An empty `requiredAreas` yields an empty missing list, which is honest:
      // nothing was missing, the registry entry was invalid. It still denies.
      missingAreas: missingAreaViews(fresh.matrix, input.requiredAreas),
    };
  }

  return { ok: true, matrix: fresh.matrix };
}
