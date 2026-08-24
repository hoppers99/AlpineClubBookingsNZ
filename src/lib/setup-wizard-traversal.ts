import { type ModuleSettingsValues } from "@/config/modules";
import { normalizeClubModuleSettings } from "@/lib/module-settings";
import {
  CORE_STEP_OWNER,
  SETUP_STEP_REGISTRY,
  isSetupStepComplete,
  type SetupStepCompletionInput,
  type SetupStepDefinition,
  type SetupStepId,
  type SetupStepOwner,
} from "@/lib/setup-step-registry";

/**
 * The setup wizard's TRAVERSAL layer (epic #213, child C4).
 *
 * Given the step registry (C1), a club's `SetupProgress` arrays and its module
 * flags, this module answers three questions and nothing else: **what state is
 * each applicable step in, where may the operator go, and how far through are
 * they?** It is pure — no I/O, no `Date`, no Prisma, no React — so C5's shell
 * and any future server route can both call it and get the same answer.
 *
 * NOT TO BE CONFUSED WITH `setup-wizard-db.ts`, which is the interactive
 * command-line installer (`scripts/setup.ts runWizard`) and shares only the
 * word "wizard". This module is the admin-UI journey of epic #213.
 *
 * ## The rules, and where each comes from
 *
 * Epic #213 decision **D2**, quoted: "Completed steps are freely reachable,
 * forwards and back. You cannot jump ahead past a step that is not done. If an
 * edit invalidates later steps, forward movement stops at the first step that
 * now needs attention."
 *
 * Three readings had to be settled before that could be code. Each is a
 * deliberate decision, not an accident of implementation, so each is stated
 * here and pinned by a test named for it:
 *
 * 1. **A DEFERRED step does not block forward movement.** #219's third
 *    acceptance criterion limits forward navigation to "the earliest step that
 *    is stale **or not started**" — pointedly not "or deferred". Read the other
 *    way round, "skip for now" would achieve nothing at all: a deferred step
 *    would stop the operator exactly like an untouched one, the state would be
 *    decorative, and D9's launch panel would be unreachable for any club that
 *    ever skipped anything — which is the opposite of mockup 6, where the
 *    journey ends with outstanding work "stated rather than hidden". So
 *    deferring is precisely how an operator buys passage. It buys passage and
 *    nothing else: a deferred step stays in the applicable set, stays
 *    outstanding, and never counts toward the percentage (D4, #219 AC 4).
 * 2. **A completed step stays reachable even when an earlier step goes stale.**
 *    AC 1 ("any completed step, in either direction") and AC 3 ("limit forward
 *    navigation") collide when step 5 is stale and step 10 is complete. AC 1 is
 *    unconditional and is stated first; AC 3 governs how far the FRONTIER
 *    advances — how far into unresolved territory the operator may walk — not
 *    whether finished work may be reviewed. Locking somebody out of a completed
 *    step 10 because step 5 needs another look would be hostile and would
 *    protect nothing: step 10 is complete and unchanged.
 * 3. **Staleness CASCADES.** If A is outstanding then B (which depends on A) is
 *    stale, and C (which depends on B) is stale too, because B may yet change.
 *    That is also the fail-toward-stale direction C2's acceptance criteria ask
 *    for ("IF the stale set cannot be computed, treat affected steps as stale
 *    rather than complete").
 *
 * ## Staleness is DERIVED here, and C2 swaps that for persistence invisibly
 *
 * Under epic decision **D11** this child takes no schema. `deriveStaleSetupStepIds`
 * is the ONE function that decides the stale set, and `buildSetupWizardTraversal`
 * is its only consumer. C2 replaces it — either by rewriting its body to read the
 * persisted column, or by leaving it alone and having its caller pass
 * `staleStepIds` — and no other line of this module, and nothing in C5, changes.
 *
 * Today every registered step declares an EMPTY prerequisite list (see
 * `setup-step-registry-definitions.ts`, which explains why: no current step's
 * status is computed from another step's status). So the real registry yields
 * an empty stale set for every possible progress record, and a test pins that.
 * The staleness rules below are exercised against synthetic registries, which is
 * the only way to test them until a genuine prerequisite is declared.
 *
 * ## Guarantees
 *
 * - **Applicability matches C1 exactly.** The rule is restated here because this
 *   module must also work over a SYNTHETIC registry (a test's, and later a
 *   module-contributed one from C3), which `getApplicableSetupStepIds` cannot
 *   take. A test asserts the two agree over the real registry for every
 *   module-flag permutation that matters, so the restatement cannot drift.
 * - **Presentation order is the registry's declaration order**, unchanged and
 *   never re-sorted. C1 makes declaration order and `order` agree and fails the
 *   build when they do not.
 * - **Unknown ids in the progress arrays are ignored.** A club that completed a
 *   step which a later version removed keeps that id in `completedStepIds`
 *   forever; it is not an error, and it must not appear in any output.
 * - **PERMISSION-AGNOSTIC, deliberately.** Epic decision D12 (per-area permission
 *   matrix, `ViewOnlyActionButton` / `AdminViewOnlySectionBanner`) lands in C5.
 *   Nothing here asks who is looking. A step being *reachable* is a statement
 *   about the journey, never about authorisation, and a caller must still apply
 *   its own permission gate before letting anybody act on one.
 *
 * NOTHING IS WIRED TO THE ADMIN UI YET. C4 is the substrate only, and its
 * acceptance criteria are about the pure functions below, not a rendered rail.
 * `buildSetupWizardTraversal` and `canNavigateToSetupStep` exist, are tested,
 * and have no production caller until C5 introduces one.
 */

/** The readiness verdict half of C1's completion predicate. */
export type SetupStepReadinessStatus = SetupStepCompletionInput["status"];

/**
 * A step declaration narrowed to a known id union. `SetupStepEntry` is the
 * `Id = SetupStepId` case; a synthetic registry supplies its own union (or
 * plain `string`), which is what lets every rule below be tested against a
 * prerequisite graph the real registry does not have.
 */
export interface SetupStepDefinitionOf<Id extends string>
  extends Omit<SetupStepDefinition, "id" | "prerequisites"> {
  readonly id: Id;
  readonly prerequisites: readonly Id[];
}

/**
 * The `SetupProgress` arrays, structurally. Declared rather than imported from
 * `setup-readiness.ts` so this module has no import edge to the 1,900-line
 * readiness builder; `SetupProgressState` satisfies it as it stands.
 *
 * Both arrays are `readonly string[]`, not `readonly Id[]`, on purpose — see the
 * unknown-id guarantee above.
 */
export interface SetupWizardTraversalProgress {
  readonly completedStepIds: readonly string[];
  readonly skippedStepIds: readonly string[];
}

export interface SetupWizardTraversalInput<Id extends string = SetupStepId> {
  readonly progress: SetupWizardTraversalProgress;
  /**
   * The club's module flags, with C1's three-state contract preserved exactly:
   * `undefined` means UNKNOWN and fails OPEN (every step applies), `null` means
   * the first-install defaults, a record is used as given.
   */
  readonly moduleSettings?: ModuleSettingsValues | null;
  /** Defaults to the real registry. Supplied by tests, and by C3 later. */
  readonly registry?: readonly SetupStepDefinitionOf<Id>[];
  /**
   * Each step's readiness verdict, keyed by id — `buildSetupReadiness`'s
   * `status` for that step. A step with no entry is treated as `not_started`,
   * so with this omitted a step counts as complete only when the operator
   * marked it complete.
   *
   * OMITTING IT IS VISIBLE, NOT SILENT: a caller that forgets shows an operator
   * a wizard parked on step one with everything outstanding, which is a bug
   * somebody reports on the first run rather than a subtly wrong percentage
   * nobody notices. C5 has the readiness result to hand and passes it.
   */
  readonly readinessStatuses?: Partial<Record<Id, SetupStepReadinessStatus>>;
  /**
   * An externally-computed stale set, which takes the place of
   * `deriveStaleSetupStepIds`. This is C2's seam: once staleness is persisted,
   * its reader passes the stored ids here and the derivation is never called.
   *
   * Ids that are not applicable, or that are not recorded complete, are
   * discarded — "stale" means "was done and now needs another look", so a step
   * nobody ever did is simply not started, whatever a stored row claims.
   *
   * THE CONTRACT (binding on #217 too — mirror it there, do not diverge): a
   * supplied set MUST already be the full transitive closure. The cascade
   * (staleness of a prerequisite propagating to its dependents) lives in
   * `deriveStaleSetupStepIds` and does NOT re-run over a supplied set — this
   * function only intersects it against "applicable and recorded complete". A
   * persistence layer that stores only direct dependents and hands them
   * straight in will silently under-report everything downstream as complete.
   * `[]` and `undefined` are different answers, not interchangeable absences:
   * `[]` means "computed: nothing is stale"; `undefined` means "derive it".
   * A reader that cannot compute the set at all must pass `undefined` (falling
   * back to derivation) or fail toward stale — never invent an empty answer it
   * does not have.
   */
  readonly staleStepIds?: readonly string[];
}

/**
 * One state per applicable step, for C5's rail.
 *
 * `current` is a state rather than a separate flag because #219 asks for it as
 * one, and exactly one step can hold it. Where it collides with `stale` or
 * `deferred` it wins — the rail has to be able to say where you are — and the
 * `isStale` / `isDeferred` flags on the step carry the rest, so a rail can
 * render "current, and needs another look" without recomputing anything.
 */
export type SetupWizardStepState =
  | "complete"
  | "current"
  | "stale"
  | "deferred"
  | "not-started";

export interface SetupWizardTraversalStep<Id extends string = SetupStepId> {
  readonly id: Id;
  readonly ownerModule: SetupStepOwner;
  readonly order: number;
  readonly state: SetupWizardStepState;
  /** Complete AND not stale. This is the one that counts toward the percentage. */
  readonly isComplete: boolean;
  /** Recorded complete, but something it depends on is outstanding. */
  readonly isStale: boolean;
  /** Deferred ("skip for now") and not complete. Outstanding, but passable. */
  readonly isDeferred: boolean;
  /** May the operator open this step? D2, as read above. */
  readonly isReachable: boolean;
}

export interface SetupWizardTraversal<Id extends string = SetupStepId> {
  /** Applicable steps only, in registry declaration order. */
  readonly steps: readonly SetupWizardTraversalStep<Id>[];
  readonly applicableStepIds: readonly Id[];
  readonly staleStepIds: readonly Id[];
  /** Everything not complete — deferred and stale included (#219 AC 4). */
  readonly outstandingStepIds: readonly Id[];
  /**
   * Not complete AND not deferred: a step that is genuinely blocking, i.e. it
   * caps the navigation frontier (stale steps are included — F2's decision
   * means a stale-and-deferred step still blocks). `isDeferred`-only steps are
   * already visible per-step and are deliberately excluded here, so a
   * consumer summing this list gets the same set the frontier walk stops on.
   */
  readonly blockingStepIds: readonly Id[];
  /** Where the operator resumes: the first applicable step that is not complete. */
  readonly currentStepId: Id | null;
  /** The furthest step reachable by walking forward from the start. */
  readonly navigationFrontierStepId: Id | null;
  /**
   * D9's launch-panel signal (#219 review round): every applicable step is
   * complete or deferred, i.e. `blockingStepIds` is empty. Exported explicitly
   * so C5 never re-derives it from the step list — a step that is BOTH stale
   * and deferred (F2) must read as unresolved here exactly as it does for the
   * frontier, and computing that inline at each call site is how the two would
   * eventually drift.
   */
  readonly allResolved: boolean;
  /**
   * D7: progress is a PERCENTAGE, because the denominator moves as modules are
   * switched on and off and a changing count reads as though work was lost. Do
   * not render this back as "x of y".
   */
  readonly percentComplete: number;
}

function applicableEntries<Id extends string>(
  registry: readonly SetupStepDefinitionOf<Id>[],
  moduleSettings: ModuleSettingsValues | null | undefined,
): readonly SetupStepDefinitionOf<Id>[] {
  // C1's three-state contract, restated: UNKNOWN fails open. Hiding setup work
  // on the one run that could not read the club's configuration is the wrong
  // direction to be wrong in — a step shown unnecessarily costs a glance, a
  // step hidden wrongly is never done.
  if (moduleSettings === undefined) return registry;

  const flags = normalizeClubModuleSettings(moduleSettings);
  return registry.filter(
    (entry) =>
      entry.ownerModule === CORE_STEP_OWNER || flags[entry.ownerModule],
  );
}

/**
 * The operator's own marking for a step. Precedence matches
 * `buildProgressState` in `setup-readiness.ts`: completed beats skipped, so an
 * id somehow present in both arrays reads as completed there and here alike.
 */
function progressStateOf(
  id: string,
  progress: SetupWizardTraversalProgress,
): SetupStepCompletionInput["progress"] {
  if (progress.completedStepIds.includes(id)) return "completed";
  if (progress.skippedStepIds.includes(id)) return "skipped";
  return "open";
}

function recordedCompleteIds<Id extends string>(
  entries: readonly SetupStepDefinitionOf<Id>[],
  input: SetupWizardTraversalInput<Id>,
): Set<Id> {
  const complete = new Set<Id>();
  for (const entry of entries) {
    const status = input.readinessStatuses?.[entry.id] ?? "not_started";
    if (
      isSetupStepComplete(entry, {
        status,
        progress: progressStateOf(entry.id, input.progress),
      })
    ) {
      complete.add(entry.id);
    }
  }
  return complete;
}

/**
 * THE stale set — the single function C2 replaces (see the module doc).
 *
 * A step is stale when it is recorded complete and any prerequisite of it is
 * outstanding, where "outstanding" itself includes being stale. Returned in
 * registry declaration order.
 *
 * Four rules that only a malformed or exotic registry can reach, stated so the
 * behaviour is a decision rather than a discovery:
 *
 * - **A prerequisite that is not APPLICABLE, but IS a real id somewhere in the
 *   whole registry, is ignored.** It can never be completed, so counting it as
 *   outstanding would pin its dependent stale forever and make the wizard
 *   unfinishable. C1's cross-module prerequisite guard means this cannot arise
 *   in the real registry: a prerequisite is either `core` (never excluded) or
 *   owned by the same module as its dependent (so the two disappear together).
 * - **A prerequisite id that matches NO entry in the whole registry — a ghost,
 *   not merely excluded by a disabled module — fails toward stale (#219 review
 *   finding F3).** The two look alike (neither is in the applicable set) but
 *   read oppositely: an excluded id is a real step that this club's module
 *   flags happen to have turned off, and ignoring it is correct; an id absent
 *   from the registry entirely is a broken reference — a typo, a step that was
 *   renamed without updating its dependents, a synthetic registry under test —
 *   and the same fail-toward-stale direction #217's own acceptance criterion
 *   asks for ("IF the stale set cannot be computed, treat affected steps as
 *   stale rather than complete") applies here too. `applicable` alone cannot
 *   tell the two apart, because both are absent from it; `known` (the full
 *   registry's ids, unfiltered by module) is what distinguishes them.
 * - **A prerequisite CYCLE among mutually-complete steps yields no stale
 *   steps.** The fixpoint below never opens such a component, because no member
 *   of it is outstanding to begin with. C1's Tarjan cycle guard fails the build
 *   on any cycle, so this is unreachable in the real registry; it is pinned by
 *   test so that a future change to either guard is a named failure rather than
 *   an infinite loop or a surprise.
 * - **A DUPLICATE id degrades rather than crashes.** Nothing here deduplicates
 *   `entries`, so two definitions sharing one id double-count that id in the
 *   applicable denominator (`toPercentComplete`) and render it twice in
 *   `steps`. C1's `findSetupStepRegistryViolations` rejects a duplicate id at
 *   CI (`setup-step-registry.test.ts`'s contract test), so this cannot reach
 *   the real registry; it is named here, not fixed here, because this module
 *   has no registry of its own to validate and must not silently paper over a
 *   guard that belongs one layer down.
 */
export function deriveStaleSetupStepIds(
  input: SetupWizardTraversalInput<SetupStepId>,
): SetupStepId[];
export function deriveStaleSetupStepIds<Id extends string>(
  input: SetupWizardTraversalInput<Id> & {
    readonly registry: readonly SetupStepDefinitionOf<Id>[];
  },
): Id[];
export function deriveStaleSetupStepIds<Id extends string = SetupStepId>(
  input: SetupWizardTraversalInput<Id>,
): Id[] {
  // Delegates to the unexported, un-overloaded implementation below. Overload
  // resolution only constrains CALLERS of the exported name; `Id` is still
  // fully generic inside this file (`buildSetupWizardTraversal` calls the
  // internal function directly, with a `registry` it cannot statically prove
  // present), so the implementation keeps the wider, cast-bearing signature.
  return computeStaleSetupStepIds(input);
}

/**
 * The un-overloaded implementation `deriveStaleSetupStepIds` and
 * `buildSetupWizardTraversal` both call. See `deriveStaleSetupStepIds` above
 * for the documented contract and rules; this split exists only so the
 * overloads that make `registry` required for external callers (F8) do not
 * also block the internal call from `buildSetupWizardTraversal`, which holds
 * the same generic, possibly-registry-less `input` its own caller was handed.
 */
function computeStaleSetupStepIds<Id extends string = SetupStepId>(
  input: SetupWizardTraversalInput<Id>,
): Id[] {
  // F8: `deriveStaleSetupStepIds`'s overloads make `registry` REQUIRED
  // whenever an external caller narrows Id away from the default.
  // `SETUP_STEP_REGISTRY` only ever supplies `SetupStepId`, so this fallback —
  // and the cast it needs, because this signature is necessarily wider than
  // either overload — is sound for every input reachable through the exported
  // name; a caller cannot reach this line with a narrowed Id and no registry.
  const registry = (input.registry ??
    SETUP_STEP_REGISTRY) as readonly SetupStepDefinitionOf<Id>[];
  const entries = applicableEntries(registry, input.moduleSettings);
  const applicable = new Set<string>(entries.map((entry) => entry.id));
  // F3: the WHOLE registry's ids, not the module-filtered `applicable` set —
  // this is what tells a genuinely unknown prerequisite apart from one that is
  // merely excluded by a disabled module.
  const known = new Set<string>(registry.map((entry) => entry.id));
  const complete = recordedCompleteIds(entries, input);

  // Fixpoint rather than a topological walk: declaration order is guaranteed to
  // put a prerequisite before its dependent in the REAL registry (C1 fails the
  // build otherwise), but a synthetic one carries no such promise, and a walk
  // that assumed it would silently under-report. Each pass adds at least one
  // member or ends the loop, so this terminates in at most |entries|+1 passes
  // (the last being the pass that finds nothing new and stops).
  const stale = new Set<Id>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (!complete.has(entry.id) || stale.has(entry.id)) continue;
      const invalidated = entry.prerequisites.some((prerequisite) => {
        // Ghost: not a real id anywhere in the registry. Fails toward stale.
        if (!known.has(prerequisite)) return true;
        // Known but excluded by a disabled module: ignored, as designed.
        if (!applicable.has(prerequisite)) return false;
        return !complete.has(prerequisite) || stale.has(prerequisite);
      });
      if (invalidated) {
        stale.add(entry.id);
        changed = true;
      }
    }
  }

  return entries.filter((entry) => stale.has(entry.id)).map((entry) => entry.id);
}

/**
 * The whole traversal, in one pass. See the module doc for the three readings
 * of D2 this encodes; every branch below is one of them.
 */
export function buildSetupWizardTraversal(
  input: SetupWizardTraversalInput<SetupStepId>,
): SetupWizardTraversal<SetupStepId>;
export function buildSetupWizardTraversal<Id extends string>(
  input: SetupWizardTraversalInput<Id> & {
    readonly registry: readonly SetupStepDefinitionOf<Id>[];
  },
): SetupWizardTraversal<Id>;
export function buildSetupWizardTraversal<Id extends string = SetupStepId>(
  input: SetupWizardTraversalInput<Id>,
): SetupWizardTraversal<Id> {
  // F8: see the matching note on `deriveStaleSetupStepIds` — the overloads
  // above are what make this fallback sound.
  const registry = (input.registry ??
    SETUP_STEP_REGISTRY) as readonly SetupStepDefinitionOf<Id>[];
  const entries = applicableEntries(registry, input.moduleSettings);
  const complete = recordedCompleteIds(entries, input);

  const suppliedStale = input.staleStepIds;
  const stale = new Set<Id>(
    suppliedStale === undefined
      ? computeStaleSetupStepIds(input)
      : // Intersect rather than trust: a stored id for a step that is not
        // recorded complete, or no longer applicable, describes a step that is
        // simply not started.
        entries
          .filter(
            (entry) =>
              complete.has(entry.id) && suppliedStale.includes(entry.id),
          )
          .map((entry) => entry.id),
  );

  const facts = entries.map((entry) => {
    const stepStale = stale.has(entry.id);
    const stepComplete = complete.has(entry.id) && !stepStale;
    return {
      entry,
      stale: stepStale,
      complete: stepComplete,
      // A step is deferred when the operator skipped it and it is not complete.
      // Completing clears the skip in the progress route, so in practice the
      // two never coexist; `progressStateOf` settles it either way.
      deferred:
        !stepComplete &&
        progressStateOf(entry.id, input.progress) === "skipped",
    };
  });

  // #219: "current" is the first applicable step that is not complete, with
  // deferred and stale both counting as not complete, until C2 decides whether
  // a stored cursor is worth its schema.
  const currentIndex = facts.findIndex((fact) => !fact.complete);

  // D2, reading 1: a deferred step is RESOLVED for navigation and outstanding
  // for everything else, so it does not cap the frontier. Reading 2: the
  // frontier is how far forward the operator may WALK; a completed step beyond
  // it stays reachable on its own account.
  //
  // #219 review finding F2 (recorded decision, binding): STALENESS ALWAYS CAPS
  // THE FRONTIER, deferred or not. A step can be both — recorded complete via
  // its own readiness check while also sitting in `skippedStepIds` from an
  // earlier pass — and when it is, the stale half wins: `isDeferred` stays
  // true (both facts are visible on the step; see `SetupWizardTraversalStep`),
  // but it is excluded from "resolved" here. Without the `fact.stale ||` half
  // a stale-and-deferred step read as resolved purely because `deferred` is
  // computed off `!stepComplete`, which staleness itself flips — the frontier
  // would then walk straight past a step that still needs another look.
  const isBlocking = (fact: (typeof facts)[number]) =>
    !fact.complete && (fact.stale || !fact.deferred);
  const firstUnresolvedIndex = facts.findIndex(isBlocking);
  const frontierIndex =
    firstUnresolvedIndex === -1 ? facts.length - 1 : firstUnresolvedIndex;

  const steps = facts.map((fact, index): SetupWizardTraversalStep<Id> => {
    const stepCurrent = index === currentIndex;
    return {
      id: fact.entry.id,
      ownerModule: fact.entry.ownerModule,
      order: fact.entry.order,
      state: fact.complete
        ? "complete"
        : stepCurrent
          ? "current"
          : fact.stale
            ? "stale"
            : fact.deferred
              ? "deferred"
              : "not-started",
      isComplete: fact.complete,
      isStale: fact.stale,
      isDeferred: fact.deferred,
      isReachable: fact.complete || index <= frontierIndex,
    };
  });

  // F9 (#219 review round, for D9's launch panel): the same `isBlocking`
  // predicate the frontier walk uses, applied to every applicable step rather
  // than stopped at the first hit. A stale-and-deferred step (F2) is blocking
  // here too, for the same reason it caps the frontier.
  const blockingStepIds = facts
    .filter((fact) => isBlocking(fact))
    .map((fact) => fact.entry.id);

  return {
    steps,
    applicableStepIds: facts.map((fact) => fact.entry.id),
    staleStepIds: facts
      .filter((fact) => fact.stale)
      .map((fact) => fact.entry.id),
    outstandingStepIds: facts
      .filter((fact) => !fact.complete)
      .map((fact) => fact.entry.id),
    blockingStepIds,
    allResolved: blockingStepIds.length === 0,
    currentStepId: currentIndex === -1 ? null : facts[currentIndex].entry.id,
    navigationFrontierStepId:
      frontierIndex >= 0 ? facts[frontierIndex].entry.id : null,
    percentComplete: toPercentComplete(
      facts.filter((fact) => fact.complete).length,
      facts.length,
    ),
  };
}

/**
 * D7's percentage.
 *
 * An EMPTY applicable set reports 100, not a division by zero: nothing
 * applicable is nothing outstanding, and #219's revisions pin that by test
 * because the original acceptance criterion left it undefined. (A club can
 * reach it only with a registry of nothing but module-owned steps and every
 * module off, which C3 makes possible.)
 *
 * The two clamps stop rounding from telling an operator a lie in either
 * direction — 100% with work left, or 0% with work done. Neither can fire below
 * roughly two hundred steps; they are here because the honest answer is cheap
 * and a rounded one is not obviously safe.
 */
function toPercentComplete(completeCount: number, applicableCount: number): number {
  if (applicableCount === 0) return 100;
  const rounded = Math.round((completeCount / applicableCount) * 100);
  if (completeCount < applicableCount && rounded >= 100) return 99;
  if (completeCount > 0 && rounded <= 0) return 1;
  return rounded;
}

/**
 * Whether the operator may open one step, by id. An id that is not applicable —
 * a disabled module's step, an id from an older version, a typo in a query
 * string — is not reachable, so a caller can pass a raw route parameter
 * straight in.
 *
 * This answers the JOURNEY question only. D12's permission gate is C5's, and
 * both have to pass.
 */
export function canNavigateToSetupStep<Id extends string>(
  traversal: SetupWizardTraversal<Id>,
  stepId: string,
): boolean {
  return (
    traversal.steps.find((step) => step.id === stepId)?.isReachable ?? false
  );
}
