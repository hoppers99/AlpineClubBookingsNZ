import { type ModuleSettingsValues } from "@/config/modules";
import { normalizeClubModuleSettings } from "@/lib/module-settings";
import {
  CORE_STEP_OWNER,
  resolveSetupStepCompletion,
  type SetupStepCompletionAnswer,
  type SetupStepCompletionInput,
  type SetupStepDefinition,
  type SetupStepId,
  type SetupStepKind,
  type SetupStepOwner,
} from "@/lib/setup-step-registry";

/**
 * The ENTRY layer beneath the setup wizard's traversal (epic #213, C4, split out
 * of `setup-wizard-traversal.ts` in C15's fix round for size).
 *
 * The traversal answers three questions about the JOURNEY — what state each step
 * is in, where the operator may go, and how far through they are. Everything it
 * needs BEFORE it can ask them lives here: which registry entries apply to this
 * club, which of those are operator steps and which are deployment facts (D17),
 * what the operator has recorded about each, and the facts themselves.
 *
 * **This is a relocation, not a second derivation.** The rules below are the
 * same ones the traversal ran inline, called once each from its single pass;
 * splitting the file did not give the wizard a second place to decide anything.
 * The traversal's own module doc states which decisions are load-bearing and
 * why, and it is still the place to read them.
 *
 * Pure — no I/O, no `Date`, no Prisma, no React — for the same reason the
 * traversal is: a server route and a test fixture must be able to get the same
 * answer.
 */

/** The readiness verdict half of C1's completion predicate. */
export type SetupStepReadinessStatus = SetupStepCompletionInput["status"];

/**
 * A step declaration narrowed to a known id union. `SetupStepEntry` is the
 * `Id = SetupStepId` case; a synthetic registry supplies its own union (or
 * plain `string`), which is what lets every traversal rule be tested against a
 * prerequisite graph the real registry does not have.
 */
export interface SetupStepDefinitionOf<Id extends string>
  extends Omit<SetupStepDefinition, "id" | "prerequisites"> {
  readonly id: Id;
  readonly prerequisites: readonly Id[];
}

/**
 * The `SetupProgress` arrays, structurally. Declared rather than imported from
 * `setup-readiness.ts` so this module and the traversal have no import edge to
 * the 1,900-line readiness builder; `SetupProgressState` satisfies it as it
 * stands.
 *
 * Both arrays are `readonly string[]`, not `readonly Id[]`, on purpose — an
 * unknown id in a stored progress array is ignored rather than being an error
 * (see the traversal's guarantees).
 */
export interface SetupWizardTraversalProgress {
  readonly completedStepIds: readonly string[];
  readonly skippedStepIds: readonly string[];
}

/**
 * One environment fact, for the wizard's Server-environment panel (D17, C15
 * #246).
 *
 * Deliberately THIN — an id, who owns it, where it sits, and the verdict its
 * readiness check reached. Everything a person reads (title, message, the
 * remedy addressed to whoever runs the server, the provider test) is the VIEW
 * layer's, assembled from the same readiness check every rail step's copy comes
 * from — see `setup-wizard-environment-view.ts`. This module is pure and has no
 * readiness result: giving it copy would make it the second place a fact's
 * wording lives.
 */
export interface SetupWizardEnvironmentFact<Id extends string = SetupStepId> {
  readonly id: Id;
  readonly ownerModule: SetupStepOwner;
  readonly order: number;
  readonly status: SetupStepReadinessStatus;
  /**
   * This fact is holding publish shut: it declared
   * `launchGate: "blocks-until-complete"` and its check is not `complete`.
   * Every such id also appears in the traversal's `launchBlockedBy`; it is
   * carried per-fact so the panel can mark the offending row without
   * re-deriving the rule.
   */
  readonly blocksLaunch: boolean;
}

/**
 * DELIBERATELY THE SAME PREDICATE AS `getApplicableSetupStepIds` in
 * `setup-step-registry.ts`, and deliberately not a call to it: that one answers
 * over the real registry and returns ids, this one filters an arbitrary
 * `registry` argument and returns entries, which is what lets the traversal be
 * tested against a fixture registry. Two copies of a rule normally drift; this
 * pair cannot go unnoticed, because `setup-surface-registry-parity.test.ts`
 * asserts the readiness cards, the hub cards and the traversal all report the
 * same step set for eight named module states (#223 AC1). Change one and that
 * suite fails.
 *
 * The rule is restated here rather than imported because this module must also
 * work over a SYNTHETIC registry (a test's, and a module-contributed one from
 * C3), which `getApplicableSetupStepIds` cannot take.
 */
export function applicableEntries<Id extends string>(
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
 * `getApplicableSetupStepIds` — the readiness cards, the hub cards and the
 * traversal are married to it by `setup-surface-registry-parity.test.ts` across
 * eight module states. Narrowing it by `kind` would silently narrow the CARDS'
 * step set too, hiding a deployment fact from the surface whose whole question
 * is "is this installation configured?". The journey narrows here, one layer
 * down, and nothing else does.
 */
export function entriesOfKind<Id extends string>(
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
export function progressStateOf(
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
 *
 * A step with no readiness entry is treated as `not_started`, so with statuses
 * omitted a step counts as complete only when the operator marked it complete.
 */
export function completionAnswers<Id extends string>(
  entries: readonly SetupStepDefinitionOf<Id>[],
  progress: SetupWizardTraversalProgress,
  readinessStatuses: Partial<Record<Id, SetupStepReadinessStatus>> | undefined,
): Map<Id, SetupStepCompletionAnswer> {
  const answers = new Map<Id, SetupStepCompletionAnswer>();
  for (const entry of entries) {
    answers.set(
      entry.id,
      resolveSetupStepCompletion(entry, {
        status: readinessStatuses?.[entry.id] ?? "not_started",
        progress: progressStateOf(entry.id, progress),
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
export function operatorConfirmedIds<Id extends string>(
  answers: ReadonlyMap<Id, SetupStepCompletionAnswer>,
): Set<Id> {
  const confirmed = new Set<Id>();
  for (const [id, answer] of answers) {
    if (answer.operatorConfirmed) confirmed.add(id);
  }
  return confirmed;
}

/**
 * The applicable ENVIRONMENT facts, in registry declaration order (D17, C15
 * #246) — the Server-environment panel's whole data set.
 *
 * Takes the SAME applicable-entry list the journey is filtered from, so this is
 * one derivation with two audiences rather than a second reader computing "the
 * applicable entries whose kind is environment" for itself.
 */
export function buildSetupWizardEnvironmentFacts<Id extends string>(
  applicable: readonly SetupStepDefinitionOf<Id>[],
  readinessStatuses: Partial<Record<Id, SetupStepReadinessStatus>> | undefined,
): readonly SetupWizardEnvironmentFact<Id>[] {
  return entriesOfKind(applicable, "environment").map((entry) => {
    const status = readinessStatuses?.[entry.id] ?? "not_started";
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
  });
}
