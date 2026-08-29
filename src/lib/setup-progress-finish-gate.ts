import { NextResponse } from "next/server";
import { recomputeSetupProgressDerivation } from "@/lib/setup-progress-staleness";
import type { SetupWizardTraversalProgress } from "@/lib/setup-wizard-entries";

/**
 * The two refusals that stand between a setup-progress transition and the write
 * (epic #213, C2/#217 and C16/#247).
 *
 * `PATCH /api/admin/setup/progress` performs five transitions. Two of them can
 * be refused by the server, for the same reason stated two ways:
 *
 * - **the snapshot could not be read** — a 503, from #217. The stale set is a
 *   value this handler cannot honestly COMPUTE, so it must not be stored;
 * - **`finish` while applicable steps are outstanding** — a 409, from #247. The
 *   completion stamp is a value the handler can compute to be UNTRUE, so it must
 *   not be stored either.
 *
 * Both refuse the WHOLE transition rather than storing a softened version of it,
 * both write nothing and audit nothing, and both say why — the no-write refusal
 * shape #217 settled. They are here rather than inline in the route because they
 * are one decision with one ordering, and because the route is a handler at its
 * size budget: the reasoning below is load-bearing and had to move somewhere
 * rather than be trimmed. `setup-progress-audit.ts` was lifted out of the same
 * route on the same grounds (C2).
 *
 * The route keeps everything that is genuinely the request's: parsing, the
 * transition arithmetic over the two arrays, the write, and the audit call.
 *
 * ## The ordering is load-bearing
 *
 * The 503 answers first. "The snapshot could not be read" is retryable and says
 * nothing about the club's steps; "these steps are outstanding" is a definite
 * claim the operator must act on. A gate that ran the other way round would
 * report a blocking list it had not actually computed.
 *
 * `reset` is settled without a recompute at all: nothing is recorded complete
 * afterwards, so nothing CAN be stale, and that is a computed answer rather than
 * a guess — it holds even when the recompute could not run.
 */

/** What the caller may do next: write with this stale set, or return this refusal. */
export type SetupProgressGateOutcome =
  | {
      readonly ok: true;
      /** The full transitive closure to persist to `SetupProgress.staleStepIds`. */
      readonly staleStepIds: readonly string[];
    }
  | { readonly ok: false; readonly refusal: NextResponse };

/**
 * `"a", "b"` — the same quoting `setup-progress-audit.ts` uses for its own step
 * lists, so an operator reading the refusal and then the audit trail sees one
 * format. Registry ids rather than titles: the refusal is #247's acceptance
 * criterion ("the blocking ids named"), the ids are what the wizard's own URLs
 * and audit rows carry, and resolving titles here would need the registry's
 * copy on a path that currently needs none of it.
 */
function quoteStepIds(ids: readonly string[]): string {
  return ids.map((id) => `"${id}"`).join(", ");
}

export interface SetupProgressGateInput {
  /** The transition the operator asked for. */
  readonly action: "complete" | "skip" | "reopen" | "finish" | "reset";
  /** The progress arrays AS THEY WILL BE STORED — after the transition, not before. */
  readonly progress: SetupWizardTraversalProgress;
}

/**
 * Recompute the derivation for a transition, and refuse it if the server can
 * see that it must not be written.
 *
 * C2 (#217): the WHOLE stale set is recomputed from the prerequisite graph, over
 * the arrays as they are about to be stored. Not patched incrementally — see
 * `setup-progress-staleness.ts` for why re-deriving on every write is what keeps
 * a corrupted or out-of-date row self-healing, and why the set has to be the
 * full transitive closure rather than the direct dependents of whichever step
 * the request touched.
 */
export async function refuseOrDeriveSetupProgress(
  input: SetupProgressGateInput,
): Promise<SetupProgressGateOutcome> {
  if (input.action === "reset") return { ok: true, staleStepIds: [] };

  const recomputed = await recomputeSetupProgressDerivation({
    progress: input.progress,
  });

  // FAIL TOWARD STALE (#217 AC 6), BY REFUSING THE WHOLE TRANSITION — the AC-6
  // resolution amendment on #217. `[]` on this column asserts "computed: nothing
  // is stale", so a recompute that could not run has no value it may honestly
  // write: `[]` inverts the acceptance criterion outright, and carrying the
  // PREVIOUS set forward is no better, because it was computed against the
  // arrays this request is replacing and would be stored beside arrays it does
  // not describe. So nothing is written, nothing is audited, and the operator is
  // told why. The failure is retryable by construction and the refusal is the
  // consistent answer rather than a new one: the same snapshot read backs the
  // wizard's own GET, which is already failing whenever this is.
  if (recomputed === null) {
    return {
      ok: false,
      refusal: NextResponse.json(
        {
          error:
            "The setup snapshot could not be read; nothing was changed — try again",
        },
        { status: 503 },
      ),
    };
  }

  // THE SERVER DECIDES WHETHER SETUP MAY BE FINISHED (C16, #247).
  //
  // Until #247 the only thing standing between a `curl` and a stamped
  // `completedAt` was the readiness page's `disabled` prop, so the C10 nudge
  // banner could be silenced by a request that skipped the button. The gate is
  // the handler's own reasoning generalised: the 503 above says a value it
  // cannot honestly COMPUTE must not be stored, and this says a value it can
  // compute to be UNTRUE must not be stored either.
  //
  // The set is the traversal's own `blockingStepIds`, over the snapshot the
  // recompute above already read: not complete, and not deliberately deferred.
  // A club that means to open with work outstanding still can — it defers those
  // steps, exactly as the wizard's launch panel already requires — so this
  // refuses only what nobody has looked at or settled.
  //
  // PRE-C15 THIS IS STRICTER THAN IT WILL BE. The environment steps are in the
  // applicable set today, so an installation that has not declared itself cannot
  // finish. That is the safe direction to be early in, and it narrows on its own
  // when C15 lands: nothing here names a step, so the gate follows whatever the
  // registry and the module flags make applicable.
  if (input.action === "finish" && recomputed.blockingStepIds.length > 0) {
    return {
      ok: false,
      refusal: NextResponse.json(
        {
          error:
            "Setup cannot be marked complete while these steps are outstanding: " +
            `${quoteStepIds(recomputed.blockingStepIds)}. Finish or skip each ` +
            "one, then try again. Nothing was changed.",
        },
        { status: 409 },
      ),
    };
  }

  return { ok: true, staleStepIds: recomputed.staleStepIds };
}
