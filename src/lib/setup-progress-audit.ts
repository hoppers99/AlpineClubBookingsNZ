import { logAudit } from "@/lib/audit";
import type { SetupStepId } from "@/lib/setup-readiness";

/**
 * What a setup-progress transition records (epic #213, C4/#219 and C2/#217).
 *
 * Every row this module writes is `category: "system"`, `entityType:
 * "SetupProgress"`, entity id `"default"`, and actor = subject = the
 * administrator who acted. Only the `action` and the `summary` differ, which is
 * the whole design: `AuditLog.action` is what the audit log's **Event Type**
 * filter selects on.
 *
 * ## Why there are seven event types and not one
 *
 * Before #219 all five progress transitions were one row, `setup_progress.update`,
 * distinguished only by a summary reading "Setup progress skip". An operator
 * could therefore ask "what happened to setup progress" and never "who deferred
 * a step" — and the wizard C5 built drives far more of these than the readiness
 * cards ever did.
 *
 * C2 (#217) added the two stale transitions, for the reason the earlier note in
 * this place gave for their absence: under D11 staleness was DERIVED on read, so
 * there was no moment at which a step BECAME stale — only a request at which it
 * was computed to be — and an audit writer on the read path would have written a
 * row per page load. Persisting the set gives the transition an instant.
 *
 * They are two actions rather than one "stale set changed" because a single
 * request can do both: the set is recomputed over the whole prerequisite graph,
 * so one transition can invalidate one branch while a readiness check that has
 * started passing clears another. A single row with a computed action would have
 * had to drop one of the two.
 *
 * ## CATEGORY IS `system`, and it does not move
 *
 * `docs/guides/audit-log.md` puts "Setup, backups, platform-level events" there,
 * and `INV-PRIV-012` files a row by its affected domain — which is the club's
 * setup, not an administrator's settings — so this is deliberately NOT the
 * `admin` an adjacent settings write would take. Because the category does not
 * move, no row changes audience and `INV-OPS-012`'s backfill obligation does not
 * arise; the two stale actions are new rows in a category that already existed,
 * never old rows moved into one.
 *
 * The rows written before #219 keep the old `setup_progress.update` action, so
 * an Event Type filter splits at that release; that is disclosed in the
 * changelog and costs a filter choice, never a permission.
 *
 * ## FIRE-AND-FORGET, AND AFTER THE WRITE
 *
 * `logAudit` rather than an awaited `createAuditLog(…, tx)`: nothing downstream
 * depends on these rows existing before the response returns, and a failed audit
 * write must not fail an operator's click. The caller invokes this only after
 * the progress row has been written, so a transition that never landed records
 * nothing.
 */

export type SetupProgressAuditAction =
  | { readonly action: "complete" | "skip" | "reopen"; readonly stepId: SetupStepId }
  | { readonly action: "finish" | "reset" };

const AUDIT_ACTION_BY_PROGRESS_ACTION: Record<
  SetupProgressAuditAction["action"],
  string
> = {
  complete: "setup_progress.step_completed",
  skip: "setup_progress.step_deferred",
  reopen: "setup_progress.step_reopened",
  finish: "setup_progress.finished",
  reset: "setup_progress.reset",
};

const AUDIT_ACTION_STEPS_MARKED_STALE = "setup_progress.steps_marked_stale";
const AUDIT_ACTION_STEPS_STALE_CLEARED = "setup_progress.steps_stale_cleared";

function summaryFor(payload: SetupProgressAuditAction): string {
  switch (payload.action) {
    case "complete":
      return `Setup step "${payload.stepId}" marked complete`;
    case "skip":
      return `Setup step "${payload.stepId}" deferred for now`;
    case "reopen":
      return `Setup step "${payload.stepId}" reopened`;
    case "finish":
      return "Setup marked finished";
    case "reset":
      return "Setup progress reset";
  }
}

/** `"a", "b"` — the same quoting the per-step summaries use. */
function quoteStepIds(ids: readonly string[]): string {
  return ids.map((id) => `"${id}"`).join(", ");
}

export interface RecordSetupProgressTransitionInput {
  readonly payload: SetupProgressAuditAction;
  readonly actorMemberId: string;
  readonly entityId: string;
  /** The stale set as it stood BEFORE this transition. */
  readonly previousStaleStepIds: readonly string[];
  /** The stale set as it was actually persisted. */
  readonly nextStaleStepIds: readonly string[];
}

/**
 * Record the transition, plus whichever stale transitions came with it.
 *
 * The stale rows are written only when the set actually MOVED — which is no
 * request at all on a registry whose steps declare no prerequisites, i.e. every
 * request today. They appear when something really did go back into question,
 * and never as background noise beside every transition.
 */
export function recordSetupProgressTransition(
  input: RecordSetupProgressTransitionInput,
): void {
  // A `finish` THAT DID NOT TAKE EFFECT EXPLAINS ITSELF ON ITS OWN ROW. The
  // record-level completion is withheld while anything is stale (#217's
  // inherited acceptance criterion), so a reader would otherwise find
  // "Setup marked finished" recorded against a record that is not marked
  // finished, with nothing on the row saying why. The blocking set travels in
  // the metadata. It is NOT the same thing as the two rows below, which record
  // the set MOVING — a finish blocked by a set that was already stale moves
  // nothing and would write neither.
  const withheldFinishMetadata =
    input.payload.action === "finish" && input.nextStaleStepIds.length > 0
      ? { staleStepIds: [...input.nextStaleStepIds] }
      : {};

  // THE FIVE SHARED FIELDS ARE REPEATED AT EACH SITE ON PURPOSE, and a spread of
  // a shared `common` object was tried first and reverted. The audit-writer
  // census resolves a write site's `category` from the event object's OWN
  // top-level keys; a spread it cannot see through makes the category
  // `forwarded`, which is a declarable state and not an error — but declaring
  // three sites as "its category comes from somewhere else" to save ten lines
  // would trade the exact property the census exists to measure for tidiness.
  logAudit({
    action: AUDIT_ACTION_BY_PROGRESS_ACTION[input.payload.action],
    memberId: input.actorMemberId,
    actorMemberId: input.actorMemberId,
    category: "system",
    entityType: "SetupProgress",
    entityId: input.entityId,
    summary: summaryFor(input.payload),
    metadata: { ...input.payload, ...withheldFinishMetadata },
  });

  const markedStale = input.nextStaleStepIds.filter(
    (id) => !input.previousStaleStepIds.includes(id),
  );
  if (markedStale.length > 0) {
    logAudit({
      action: AUDIT_ACTION_STEPS_MARKED_STALE,
      memberId: input.actorMemberId,
      actorMemberId: input.actorMemberId,
      category: "system",
      entityType: "SetupProgress",
      entityId: input.entityId,
      summary: `Setup steps ${quoteStepIds(markedStale)} now need another look`,
      metadata: { ...input.payload, stepIds: markedStale },
    });
  }

  const clearedStale = input.previousStaleStepIds.filter(
    (id) => !input.nextStaleStepIds.includes(id),
  );
  if (clearedStale.length > 0) {
    logAudit({
      action: AUDIT_ACTION_STEPS_STALE_CLEARED,
      memberId: input.actorMemberId,
      actorMemberId: input.actorMemberId,
      category: "system",
      entityType: "SetupProgress",
      entityId: input.entityId,
      summary: `Setup steps ${quoteStepIds(clearedStale)} no longer need another look`,
      metadata: { ...input.payload, stepIds: clearedStale },
    });
  }
}
