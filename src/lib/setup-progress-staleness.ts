import logger from "@/lib/logger";
import {
  buildSetupReadiness,
  normalizeSetupProgress,
  type SetupReadiness,
} from "@/lib/setup-readiness";
import { getSetupDatabaseSnapshot } from "@/lib/setup-readiness-db";
import {
  SETUP_STEP_REGISTRY,
  type SetupStepId,
} from "@/lib/setup-step-registry";
import {
  deriveStaleSetupStepIds,
  type SetupStepDefinitionOf,
  type SetupWizardTraversalInput,
  type SetupWizardTraversalProgress,
} from "@/lib/setup-wizard-traversal";

/**
 * The WRITE side of setup-step staleness (epic #213, child C2/#217).
 *
 * C4 left one seam — `SetupWizardTraversalInput.staleStepIds` — and said C2
 * would swap the derivation behind it for a read of a stored column. This
 * module is that swap, and it is deliberately two small functions rather than
 * one: **`recomputeSetupStaleStepIds` decides what to store**, and
 * **`storedSetupStaleStepIds` decides whether the stored answer may be
 * trusted**. The progress route calls the first, the wizard read route calls
 * the second, and nothing else calls either.
 *
 * ## Why store it at all, given C4 could already derive it
 *
 * The recorded decision on #217, in one line: **the audit obligation decides
 * it.** #219 asks for a stale transition to be audited like the other four, and
 * derive-on-read has no transition instant — there is no moment at which a step
 * becomes stale, only a request at which it is computed to be, so an audit
 * writer on the read path would record a row per page load. Persisting the set
 * gives the transition an instant, and one write site records it.
 *
 * ## The store is a CACHE OF THE LAST WRITE-TIME DERIVATION, never an authority
 *
 * `integration-wizard-progress.ts` is the in-repo precedent the issue asks to
 * cite, and it is cited for its shape rather than its storage: it keeps
 * persisted step state ADVISORY and re-derives truth. The same principle holds
 * here in a different place — every write recomputes the whole set from the
 * prerequisite graph rather than patching the stored one incrementally, so a
 * row corrupted by hand, by a restore, or by a release that computed it under a
 * different registry heals on the next transition instead of compounding.
 *
 * That is also why an incremental "add the dependents of the step that just
 * changed" was rejected. It would be cheaper and it would be wrong twice over:
 * it could not remove an id that stopped being stale, and it stores direct
 * dependents while the seam contract binds the column to the full TRANSITIVE
 * CLOSURE — the traversal does not re-cascade a set it is handed, so a
 * closure-less store silently under-reports everything downstream as complete.
 *
 * ## The fail direction, in both functions
 *
 * #217's acceptance criterion is that a stale set which cannot be computed
 * fails toward stale rather than toward complete. There are two separate
 * failures and they are answered differently:
 *
 * - **The write cannot compute the set** (`recomputeSetupStaleStepIds` returns
 *   `null`): the caller keeps whatever was already stored. It must NOT store
 *   `[]`, which on this column asserts "computed: nothing is stale" — an answer
 *   it does not have. Keeping the previous set never clears staleness on the
 *   strength of a failed read, and the transition itself still goes through, so
 *   an operator is never blocked from marking a step done because an unrelated
 *   readiness probe was unavailable.
 * - **The read cannot trust the stored set** (`storedSetupStaleStepIds` returns
 *   `undefined`): the traversal derives it fresh, which is the seam's own
 *   documented fallback and computes the honest answer rather than a stored
 *   guess. `[]` is never invented for an absent row.
 */

/**
 * Each step's readiness verdict keyed by id — what the traversal needs to know
 * a step's own check passes rather than only that the operator acknowledged it.
 *
 * Lives here rather than in either route because BOTH the wizard read and the
 * progress write now need it, and two copies of "flatten the readiness
 * categories" would eventually disagree about which one wins when an id appears
 * twice.
 */
export function setupReadinessStatusesOf(
  readiness: SetupReadiness,
): SetupWizardTraversalInput<SetupStepId>["readinessStatuses"] {
  const statuses: Partial<
    Record<
      SetupStepId,
      SetupReadiness["categories"][number]["checks"][number]["status"]
    >
  > = {};
  for (const category of readiness.categories) {
    for (const check of category.checks) {
      statuses[check.id] = check.status;
    }
  }
  return statuses;
}

export interface RecomputeSetupStaleStepIdsInput {
  /** The progress arrays AS THEY WILL BE STORED — after the transition, not before. */
  readonly progress: SetupWizardTraversalProgress;
  /**
   * Defaults to the real registry, widened to the loose id type
   * `deriveStaleSetupStepIds`'s generic overload takes (`readonly
   * SetupStepEntry[]` is assignable to `readonly
   * SetupStepDefinitionOf<string>[]`, because `id` and `prerequisites` are both
   * read-only and therefore covariant).
   *
   * Supplied by tests today — staleness is structurally unreachable in the real
   * registry until some step declares a prerequisite, so a synthetic graph is
   * the only way to exercise the write path at all — and by C3's
   * module-contributed steps later.
   */
  readonly registry?: readonly SetupStepDefinitionOf<string>[];
}

/**
 * The stale set to store for `progress`, or `null` when it could not be
 * computed at all.
 *
 * `null` is a third answer and not an error: the caller keeps the previously
 * stored set (see the fail direction above). The only way to reach it is the
 * database snapshot read failing, because everything after that is pure.
 *
 * NOT WRAPPED IN THE CALLER'S TRANSACTION, deliberately. The snapshot is a wide
 * multi-table read whose subject matter — whether Stripe keys are present,
 * whether a lodge exists — is external-world state that no transaction could
 * make consistent with the progress row anyway, and holding a connection open
 * across it would put a two-dozen-query read inside a write transaction for no
 * isolation gained.
 */
export async function recomputeSetupStaleStepIds(
  input: RecomputeSetupStaleStepIdsInput,
): Promise<string[] | null> {
  let readiness: SetupReadiness;
  let moduleSettings: SetupWizardTraversalInput<string>["moduleSettings"];
  try {
    const database = await getSetupDatabaseSnapshot();
    readiness = buildSetupReadiness({
      database,
      progress: normalizeSetupProgress({
        completedStepIds: input.progress.completedStepIds,
        skippedStepIds: input.progress.skippedStepIds,
      }),
    });
    // The snapshot's own three-state contract, passed through untouched:
    // `undefined` (unknown) fails open, `null` means first-install defaults.
    moduleSettings = database.adminModuleSettings;
  } catch (err) {
    logger.error(
      { err },
      "Failed to recompute the stale setup step set; keeping the stored one",
    );
    return null;
  }

  return deriveStaleSetupStepIds<string>({
    progress: input.progress,
    moduleSettings,
    readinessStatuses: setupReadinessStatusesOf(readiness),
    registry: input.registry ?? SETUP_STEP_REGISTRY,
  });
}

/**
 * The stored set as the traversal's `staleStepIds` argument, or `undefined`
 * when there is nothing trustworthy to hand it.
 *
 * Two cases return `undefined`, and neither returns `[]`:
 *
 * - **No row at all.** A club that has never touched setup progress has no
 *   stored answer, and `[]` would claim one. Deriving costs nothing and is
 *   right (nothing is recorded complete, so nothing can be stale).
 * - **The column is not an array of strings.** Prisma's types say it always is;
 *   this row can also arrive from a restore, a hand-edited database or a
 *   config-transfer import, and a defensive check here is what keeps a
 *   malformed value from being handed on as though it had been computed.
 */
export function storedSetupStaleStepIds(
  record: { readonly staleStepIds?: unknown } | null | undefined,
): readonly string[] | undefined {
  if (!record) return undefined;
  const stored = record.staleStepIds;
  if (!Array.isArray(stored)) return undefined;
  if (!stored.every((id): id is string => typeof id === "string")) {
    return undefined;
  }
  return stored;
}

