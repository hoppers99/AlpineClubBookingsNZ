import { type ModuleSettingsValues } from "@/config/modules";
import { normalizeClubModuleSettings } from "@/lib/module-settings";
import {
  CORE_STEP_OWNER,
  SETUP_STEP_REGISTRY,
  resolveSetupStepCompletion,
  type SetupStepCompletionAnswer,
  type SetupStepCompletionInput,
  type SetupStepDefinition,
  type SetupStepId,
  type SetupStepKind,
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
 *    **A DEFAULTED step is the opposite case and blocks like an untouched
 *    one** — D14/D15 below.
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
 * ## D14 and D15: a default is not a confirmation (#237)
 *
 * UAT opened a freshly seeded install and found the wizard 56% through a journey
 * nobody had walked, resuming at step 3, with the club still called "Example
 * Mountain Club". The cause was one `||`: the old `isSetupStepComplete` read a
 * passing readiness check and an operator's record as the same evidence, and a
 * seed writes enough defaults to satisfy nine of sixteen checks.
 *
 * **D14 — the honest drop.** `SetupStepCompletionAnswer` keeps the two apart,
 * and everything that reads as PROGRESS here counts `operatorConfirmed` only:
 * `percentComplete`, `isComplete`, `currentStepId`, and the `complete` state. No
 * backfill — every install's number falls once, which costs nobody while the
 * wizard is deployed nowhere, and the percentage keeps ONE meaning.
 *
 * **D15 — defaulted blocks the frontier; skip is the escape.** A step whose
 * check passes with no operator record is `defaulted` and caps the frontier
 * exactly as `not-started` does, with no special case: `isBlocking` is
 * `!complete && (stale || !deferred)` and a defaulted step is none of the three.
 * Confirming or skipping is how an operator passes it, so `allResolved` — and
 * with it D9's launch panel — now waits for every applicable step to be
 * confirmed or skipped. That cost is the decision, not an oversight.
 *
 * **A defaulted step cannot be stale, structurally.** The stale set is
 * intersected against CONFIRMED steps and `defaulted` requires `!confirmed`, so
 * the two are disjoint by construction. D3 is otherwise untouched.
 *
 * ## Staleness is DERIVED here, and C2 swapped that for persistence invisibly
 *
 * Under epic decision **D11** child C4 took no schema, and `deriveStaleSetupStepIds`
 * was the ONE function that decided the stale set. C2 (#217) replaced it the
 * second of the two ways this note anticipated — by leaving the derivation alone
 * and having the caller pass `staleStepIds` from `SetupProgress.staleStepIds`,
 * recomputed and stored on every progress write. Not one line below changed, and
 * nothing in C5 changed. The derivation is still live and still authoritative:
 * it is what the write side calls to compute what to store, and what this module
 * falls back to whenever a reader has no trustworthy stored set to hand it.
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
 * one, and exactly one step can hold it. Where it collides with `stale`,
 * `deferred` or `defaulted` it wins — the rail has to be able to say where you
 * are — and the `isStale` / `isDeferred` / `isDefaulted` flags on the step carry
 * the rest, so a rail can render "current, and a default is in place" without
 * recomputing anything.
 *
 * `defaulted` (D14, #237) sits LAST in that precedence because it is the weakest
 * claim: the other three rest on something a person did, and this rests only on
 * a check the system ran.
 */
export type SetupWizardStepState =
  | "complete"
  | "current"
  | "stale"
  | "deferred"
  | "defaulted"
  | "not-started";

export interface SetupWizardTraversalStep<Id extends string = SetupStepId> {
  readonly id: Id;
  readonly ownerModule: SetupStepOwner;
  readonly order: number;
  readonly state: SetupWizardStepState;
  /**
   * CONFIRMED and not stale — the one that counts toward the percentage. A
   * passing readiness check alone is `isDefaulted` instead (D14).
   */
  readonly isComplete: boolean;
  /** Confirmed, but something it depends on is outstanding. */
  readonly isStale: boolean;
  /** Deferred ("skip for now") and not complete. Outstanding, but passable. */
  readonly isDeferred: boolean;
  /**
   * The check passes and NOBODY confirmed it (D14, #237) — a default is in place
   * and wants reviewing. Outstanding, and NOT passable: it caps the frontier
   * exactly as an untouched step does (D15). Never true alongside `isStale`,
   * which is intersected against confirmed steps.
   */
  readonly isDefaulted: boolean;
  /** May the operator open this step? D2, as read above. */
  readonly isReachable: boolean;
}

/**
 * One environment fact, for the wizard's Server-environment panel (D17, C15
 * #246).
 *
 * Deliberately THIN — an id, who owns it, where it sits, and the verdict its
 * readiness check reached. Everything a person reads (title, message, the
 * remedy addressed to whoever runs the server, the provider test) is the VIEW
 * layer's, assembled from the same readiness check every rail step's copy comes
 * from. This module is pure and has no readiness result: giving it copy would
 * make it the second place a fact's wording lives.
 */
export interface SetupWizardEnvironmentFact<Id extends string = SetupStepId> {
  readonly id: Id;
  readonly ownerModule: SetupStepOwner;
  readonly order: number;
  readonly status: SetupStepReadinessStatus;
  /**
   * This fact is holding publish shut: it declared
   * `launchGate: "blocks-until-complete"` and its check is not `complete`.
   * Every such id also appears in `launchBlockedBy`; it is carried per-fact so
   * the panel can mark the offending row without re-deriving the rule.
   */
  readonly blocksLaunch: boolean;
}

export interface SetupWizardTraversal<Id extends string = SetupStepId> {
  /**
   * The OPERATOR steps that apply, in registry declaration order — the rail,
   * the frontier, the percentage's denominator and `allResolved`'s subject.
   *
   * Since D17 (#246) this is a SUBSET of `applicableStepIds`, and the
   * difference is exactly `environmentFacts`. Before D17 the two were the same
   * list, and the whole point of the split is that an operator is no longer
   * walked through three screens they cannot act on.
   */
  readonly steps: readonly SetupWizardTraversalStep<Id>[];
  /**
   * EVERY applicable entry — operator steps and environment facts alike — in
   * registry declaration order.
   *
   * **It deliberately did NOT narrow with `steps` under D17 (#246).** This is
   * the field the readiness cards and `npm run setup:check` are married to:
   * `setup-surface-registry-parity.test.ts` compares it against
   * `getApplicableSetupStepIds` and against the cards' own check list across
   * eight named module states, and that marriage is what C8 exists to enforce.
   * The cards answer "is this installation configured?", where a deployment
   * fact is squarely in scope; only the WIZARD's question ("has the operator
   * been through this?") narrows. Narrowing here would have broken the one
   * contract holding three surfaces to a single derivation, to save deriving a
   * list this function already has.
   */
  readonly applicableStepIds: readonly Id[];
  /**
   * The applicable ENVIRONMENT facts, in registry declaration order (D17, C15
   * #246) — `applicableStepIds` minus `steps`, and the Server-environment
   * panel's whole data set.
   *
   * Derived in this same pass, from the same registry, by the same
   * applicability filter that produced the steps: one derivation, two
   * audiences. A second reader computing "the applicable entries whose kind is
   * environment" for itself is the drift this field exists to prevent.
   */
  readonly environmentFacts: readonly SetupWizardEnvironmentFact<Id>[];
  /**
   * The environment facts holding publish shut (D17, C15 #246): declared
   * `launchGate: "blocks-until-complete"` and not `complete`.
   *
   * **Kept out of `allResolved`, deliberately.** D9's "setup-done, site-visible
   * and environment-role are three separate facts" is the rule, and folding a
   * deployment fault into `allResolved` would re-create D14's
   * one-number-two-meanings defect a layer up: the launch panel would stop
   * rendering, so the operator would lose the very screen that tells them what
   * is wrong. The panel still unlocks on `allResolved`; the PUBLISH BUTTON is
   * what this list refuses, with the reason stated beside it.
   *
   * Empty is the ordinary answer, and an empty environment fact set produces it
   * trivially — nothing here fails closed on a club that has none.
   */
  readonly launchBlockedBy: readonly Id[];
  readonly staleStepIds: readonly Id[];
  /** Not complete — deferred, stale and DEFAULTED alike (#219 AC 4, D14). */
  readonly outstandingStepIds: readonly Id[];
  /**
   * Not complete AND not deferred: a step that is genuinely blocking, i.e. it
   * caps the navigation frontier (stale steps are included — F2's decision
   * means a stale-and-deferred step still blocks; defaulted steps are included
   * because D15 says a default is not a confirmation). `isDeferred`-only steps
   * are already visible per-step and are deliberately excluded here, so a
   * consumer summing this list gets the same set the frontier walk stops on.
   */
  readonly blockingStepIds: readonly Id[];
  /** Where the operator resumes: the first step they have not CONFIRMED (D14). */
  readonly currentStepId: Id | null;
  /** The furthest step reachable by walking forward from the start. */
  readonly navigationFrontierStepId: Id | null;
  /**
   * D9's launch-panel signal (#219 review round): every applicable step is
   * confirmed or deferred, i.e. `blockingStepIds` is empty. Exported explicitly
   * so C5 never re-derives it from the step list — a step that is BOTH stale
   * and deferred (F2) must read as unresolved here exactly as it does for the
   * frontier, and computing that inline at each call site is how the two would
   * eventually drift.
   *
   * D15 tightened this deliberately: a DEFAULTED step is unresolved, so the
   * panel unlocks only once a person has confirmed or skipped every applicable
   * step. A club can still get there in one pass by skipping; what it can no
   * longer do is arrive without anybody having looked.
   */
  readonly allResolved: boolean;
  /**
   * D7: progress is a PERCENTAGE, because the denominator moves as modules are
   * switched on and off and a changing count reads as though work was lost. Do
   * not render this back as "x of y". D14: the numerator is CONFIRMED steps, so
   * a fresh install reads 0% however many checks its defaults satisfy.
   */
  readonly percentComplete: number;
}

/**
 * DELIBERATELY THE SAME PREDICATE AS `getApplicableSetupStepIds` in
 * `setup-step-registry.ts`, and deliberately not a call to it: that one answers
 * over the real registry and returns ids, this one filters an arbitrary
 * `registry` argument and returns entries, which is what lets this module be
 * tested against a fixture registry. Two copies of a rule normally drift; this
 * pair cannot go unnoticed, because `setup-surface-registry-parity.test.ts`
 * asserts the readiness cards, the hub cards and this traversal all report the
 * same step set for eight named module states (#223 AC1). Change one and that
 * suite fails.
 */
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
 * The applicable entries of one KIND (D17, C15 #246).
 *
 * Written as a filter over `applicableEntries`' result rather than folded INTO
 * that function, and the distinction is load-bearing rather than stylistic.
 * `applicableEntries` above is contractually the same predicate as
 * `getApplicableSetupStepIds` — the readiness cards, the hub cards and this
 * traversal are married to it by `setup-surface-registry-parity.test.ts` across
 * eight module states. Narrowing it by `kind` would silently narrow the CARDS'
 * step set too, hiding a deployment fact from the surface whose whole question
 * is "is this installation configured?". The journey narrows here, one layer
 * down, and nothing else does.
 */
function entriesOfKind<Id extends string>(
  entries: readonly SetupStepDefinitionOf<Id>[],
  kind: SetupStepKind,
): readonly SetupStepDefinitionOf<Id>[] {
  return entries.filter((entry) => entry.kind === kind);
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

/**
 * Both completion answers for every applicable step, resolved once. Keyed by id
 * rather than returned as two sets, so a caller cannot read one half for one
 * step and the other half for another.
 */
function completionAnswers<Id extends string>(
  entries: readonly SetupStepDefinitionOf<Id>[],
  input: SetupWizardTraversalInput<Id>,
): Map<Id, SetupStepCompletionAnswer> {
  const answers = new Map<Id, SetupStepCompletionAnswer>();
  for (const entry of entries) {
    const status = input.readinessStatuses?.[entry.id] ?? "not_started";
    answers.set(
      entry.id,
      resolveSetupStepCompletion(entry, {
        status,
        progress: progressStateOf(entry.id, input.progress),
      }),
    );
  }
  return answers;
}

/**
 * The steps the OPERATOR has confirmed (D14, #237) — what `recordedCompleteIds`
 * was called while it also held steps nobody had recorded anything about. It is
 * the set staleness is intersected against, `percentComplete` counts, and
 * `currentStepId` walks past.
 */
function operatorConfirmedIds<Id extends string>(
  answers: ReadonlyMap<Id, SetupStepCompletionAnswer>,
): Set<Id> {
  const confirmed = new Set<Id>();
  for (const [id, answer] of answers) {
    if (answer.operatorConfirmed) confirmed.add(id);
  }
  return confirmed;
}

/**
 * THE stale set — the single function C2 replaces (see the module doc).
 *
 * A step is stale when the operator CONFIRMED it and any prerequisite of it is
 * outstanding, where "outstanding" itself includes being stale. Returned in
 * registry declaration order.
 *
 * D14 (#237) narrowed both ends of that sentence, deliberately. A step nobody
 * confirmed can never be stale — "was done and now needs another look" is not
 * true of it. And a prerequisite sitting on its own defaults is OUTSTANDING, so
 * a confirmed dependent goes stale: what it was checked against was never
 * agreed by anybody, which is the case D3 exists for. The real registry
 * declares no prerequisites, so both are pinned against synthetic ones.
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
  // D17 (#246): staleness is a property of the JOURNEY — "was done and now
  // needs another look" — and an environment fact was never done, because
  // nobody can confirm one. Excluding them here is correct rather than merely
  // convenient: left in, every environment fact would sit permanently in the
  // `complete`-set complement and be considered as a dependent on every pass,
  // for a result that can never change.
  const entries = entriesOfKind(
    applicableEntries(registry, input.moduleSettings),
    "operator",
  );
  const applicable = new Set<string>(entries.map((entry) => entry.id));
  // F3: the WHOLE registry's ids, not the module-filtered `applicable` set —
  // this is what tells a genuinely unknown prerequisite apart from one that is
  // merely excluded by a disabled module.
  const known = new Set<string>(registry.map((entry) => entry.id));
  const complete = operatorConfirmedIds(completionAnswers(entries, input));

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
  // D17 (#246), and this is the WHOLE engine change. `applicable` is the cards'
  // set and stays exactly what it was; `entries` — the journey — is its
  // operator half. Everything downstream is built from `entries` as it always
  // was, so `currentIndex`, the frontier, `steps`, `blockingStepIds`,
  // `allResolved` and `percentComplete` all narrow together without another
  // line being touched. That single seam is why the field costs twenty
  // declarations and almost nothing here.
  const applicable = applicableEntries(registry, input.moduleSettings);
  const entries = entriesOfKind(applicable, "operator");
  const answers = completionAnswers(entries, input);
  const confirmed = operatorConfirmedIds(answers);

  const environmentFacts = entriesOfKind(applicable, "environment").map(
    (entry): SetupWizardEnvironmentFact<Id> => {
      const status = input.readinessStatuses?.[entry.id] ?? "not_started";
      return {
        id: entry.id,
        ownerModule: entry.ownerModule,
        order: entry.order,
        status,
        // `!== "complete"` is the whole predicate — see `SetupStepLaunchGate`
        // in the registry for why that lands exactly on D17's three named
        // conditions rather than approximating them. `not_started` (no
        // readiness result was supplied at all) counts as not complete, which
        // is the fail-closed direction: a caller that could not read the
        // deployment must not thereby unlock a publish.
        blocksLaunch:
          entry.launchGate === "blocks-until-complete" && status !== "complete",
      };
    },
  );

  const suppliedStale = input.staleStepIds;
  const stale = new Set<Id>(
    suppliedStale === undefined
      ? computeStaleSetupStepIds(input)
      : // Intersect rather than trust: a stored id for a step the operator has
        // not confirmed, or one no longer applicable, describes a step that is
        // simply not started (or defaulted).
        entries
          .filter(
            (entry) =>
              confirmed.has(entry.id) && suppliedStale.includes(entry.id),
          )
          .map((entry) => entry.id),
  );

  const facts = entries.map((entry) => {
    const stepConfirmed = confirmed.has(entry.id);
    const stepStale = stale.has(entry.id);
    const stepComplete = stepConfirmed && !stepStale;
    // A step is deferred when the operator skipped it and it is not complete.
    // Completing clears the skip in the progress route, so in practice the
    // two never coexist; `progressStateOf` settles it either way.
    const stepDeferred =
      !stepComplete && progressStateOf(entry.id, input.progress) === "skipped";
    return {
      entry,
      stale: stepStale,
      complete: stepComplete,
      deferred: stepDeferred,
      /*
        D14/D15 (#237): the check passes and nobody confirmed it.

        `!stepConfirmed`, NOT `!stepComplete` — the two differ on a STALE step,
        which the operator DID confirm but whose staleness clears `complete`, so
        off `!stepComplete` it would read stale and defaulted at once. Pinned by
        "never reports a stale step as defaulted". Deferral wins over it too: a
        skipped step is one the operator acted on, and that act bought passage.
      */
      defaulted:
        !stepConfirmed &&
        !stepDeferred &&
        (answers.get(entry.id)?.derivedSatisfied ?? false),
    };
  });

  // #219: "current" is the first applicable step that is not complete, with
  // deferred, stale and — since D14 — defaulted all counting as not complete.
  // C2 (#217) considered a
  // stored `currentStepId` cursor riding its migration and DECLINED it: with C5
  // shipped, the only thing that knows where the operator is browsing is the
  // shell's own selection state, and persisting that is UI work #217 puts out of
  // scope — so the column would have had no writer. This derivation is the
  // definition, not a placeholder for one.
  const currentIndex = facts.findIndex((fact) => !fact.complete);

  // D2, reading 1: a deferred step is RESOLVED for navigation and outstanding
  // for everything else, so it does not cap the frontier. Reading 2: the
  // frontier is how far forward the operator may WALK; a completed step beyond
  // it stays reachable on its own account.
  //
  // #219 review finding F2 (recorded decision, binding): STALENESS ALWAYS CAPS
  // THE FRONTIER, deferred or not. D14 (#237) did not overturn that — it made
  // the combination UNREACHABLE. Staleness is intersected against CONFIRMED
  // steps, and `progressStateOf` answers "completed" or "skipped" but never
  // both, so nothing can be stale and deferred at once any more. The
  // `fact.stale ||` clause is kept as a guard on that one line of precedence,
  // which is the cheap side to be wrong on if it ever moves; the reasoning and
  // F2's own reproducer are in "no longer admits F2's stale-AND-deferred step
  // at all, since D14".
  //
  // D15 (#237) needs NO CLAUSE HERE, which is the point: a defaulted step is not
  // complete, not stale and not deferred, so this already blocks on it, and a
  // `|| fact.defaulted` would be a second thing to keep in step with `allResolved`.
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
              : fact.defaulted
                ? "defaulted"
                : "not-started",
      isComplete: fact.complete,
      isStale: fact.stale,
      isDeferred: fact.deferred,
      isDefaulted: fact.defaulted,
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
    // NOT `facts.map(...)` any more (D17, #246): `facts` is the operator half,
    // and this field is the cards' whole set. See its docblock for why the two
    // parted company here rather than in `applicableEntries`.
    applicableStepIds: applicable.map((entry) => entry.id),
    environmentFacts,
    launchBlockedBy: environmentFacts
      .filter((fact) => fact.blocksLaunch)
      .map((fact) => fact.id),
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
