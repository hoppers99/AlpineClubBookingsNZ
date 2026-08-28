import { type ModuleKey, type ModuleSettingsValues } from "@/config/modules";
import { normalizeClubModuleSettings } from "@/lib/module-settings";
import { SETUP_STEP_DEFINITIONS } from "@/lib/setup-step-registry-definitions";

/**
 * The setup step registry (epic #213, child C1; assembly extended by C3
 * #218).
 *
 * Replaces the hand-maintained `SETUP_STEP_IDS` array that used to live in
 * `setup-readiness.ts`. A step now DECLARES the module that owns it, the steps
 * it genuinely depends on, its presentation order, and how its completion is
 * determined; `SETUP_STEP_IDS` is derived from those declarations, so every
 * existing consumer keeps the same export, the same type and the same order.
 *
 * The definitions live in `setup-step-registry-definitions.ts`, which now
 * assembles them from two sources: the `core` steps declared inline there, and
 * each module's own steps declared on its `MODULE_DEFINITIONS` entry
 * (`src/config/modules.ts`, `setupSteps`) — a module declares its wizard steps
 * where it declares itself, so enabling/disabling code review of a module's
 * flag surfaces its setup steps in the same diff. This module (this file)
 * holds the contract, the derivation, the applicability rule and the guards,
 * all unchanged in shape by that assembly split. Prior art for the split is
 * `config-self-heal.ts` / `config-self-heal-steps.ts`, which solves a
 * different problem (silent repair of missing rows, not an operator journey)
 * with the same shape.
 *
 * Guarantees:
 * - **Derived, not parallel.** `SETUP_STEP_IDS` is computed from the definition
 *   array's positions. There is no second list to keep in step, which is the
 *   whole point: the flat array gained three hand-added ids in a fortnight and
 *   said nothing about who owned them.
 * - **`SETUP_STEP_IDS` stays a readonly tuple of LITERALS.** This is load-bearing
 *   and fails silently if broken. `z.enum(SETUP_STEP_IDS)` in
 *   `src/app/api/admin/setup/progress/route.ts` is the only non-test consumer
 *   outside `setup-readiness.ts`, and `z.enum` also accepts a plain
 *   `readonly string[]` — so if this export ever widens, `SetupStepId` degrades
 *   to `string`, the API stops validating step ids, and everything still
 *   typechecks. The contract test asserts the type is a literal union, because
 *   no runtime assertion can see the difference.
 * - **Order is declaration order.** The literal tuple above is only derivable
 *   from the array's POSITIONS — a `sort()` erases it to `string[]`. So `order`
 *   and position must agree, and `findSetupStepRegistryViolations` enforces it.
 *   Move a step by moving its entry.
 * - **Applicability is derived, never persisted.** A step whose owning module is
 *   disabled is excluded from the applicable set (epic #213 D4: a declined
 *   module contributes nothing and leaves no record beyond its own toggle).
 *   `core` steps are always applicable.
 * - **Guards fail the build.** "The build fails" here means a failing contract
 *   test in the `verify` job — `setup-step-registry.test.ts` asserts
 *   `findSetupStepRegistryViolations(SETUP_STEP_REGISTRY)` is empty. The
 *   registry deliberately does NOT throw at module load: a bad declaration
 *   should redden CI, not crash a running club's admin pages.
 *
 * APPLICABILITY IS NOW WIRED ON BOTH SURFACES (epic #213, C8 #223). C1 shipped
 * `getApplicableSetupStepIds` as an inert substrate — computed, tested, and
 * consumed by nothing, so the readiness cards' step set was unchanged. C4 wired
 * it into `buildSetupWizardTraversal`, and C8 wired it into
 * `buildSetupReadiness`, which is what makes it the SINGLE derivation both the
 * cards and the wizard read: a step whose owning module is off is absent from
 * the cards, from the wizard rail, from `summary.total` and from the
 * `setup:check` report, and neither surface can report a total the other
 * disagrees with. `setup-surface-registry-parity.test.ts` is the
 * fail-closed contract that keeps them married.
 */

/** Owner value for a step that belongs to no module and can never be switched off. */
export const CORE_STEP_OWNER = "core";

export type SetupStepOwner = ModuleKey | typeof CORE_STEP_OWNER;

/**
 * How a step's completion is determined. One member today: every existing step
 * is decided by its own readiness check in `setup-readiness.ts`, keyed by the
 * same id. It is a union rather than a fixed rule so a module-contributed step
 * (epic #213, child C3) could have its completion come from somewhere else
 * without touching the other declarations.
 */
export type SetupStepCompletionSource = "readiness-check";

/**
 * WHO CAN ACT ON THIS ENTRY (epic #213, **D17**, child C15 #246).
 *
 * Until D17 every readiness check was also a wizard step, and UAT round 2 found
 * what that costs: three consecutive screens — `environment-role`, `runtime-env`,
 * `auth-secret-strength` — that an operator sitting in the wizard cannot act on
 * at all, and is made to click through to reach the ones they can. Their subject
 * is the DEPLOYMENT, and the person who can change a deployment's `.env` is by
 * definition not the person reading this screen: if they were, they would have
 * restarted the server rather than pressed "Mark this step done".
 *
 * - `operator` — an administrator can move this from not-done to done by their
 *   own action, inside this application. It is a step: it is on the rail, it
 *   counts toward D7's percentage, it caps D2's frontier, and it is one of the
 *   things `allResolved` is about.
 * - `environment` — the check reports a fact about the DEPLOYMENT that no
 *   in-app action changes. It is not a step. It never appears on the rail,
 *   contributes nothing to the percentage or the frontier, and cannot be
 *   confirmed, skipped or reopened; it is REPORTED, on the wizard's
 *   Server-environment panel, with a remedy addressed to whoever runs the
 *   server.
 *
 * **REQUIRED, not optional-with-a-default, and that is the whole point.** This
 * registry's founding complaint is a flat array that "gained three hand-added
 * ids in a fortnight and said nothing about who owned them" (see the module doc
 * above). A `kind` defaulting to `"operator"` would decide this question
 * silently for every step somebody adds without thinking about it — and
 * "silently deciding a question nobody was asked" is the exact defect the
 * registry exists to prevent. This epic already pays that tax three times over
 * (`SETUP_STEP_PERMISSION_AREA`, `SETUP_STEP_DEFAULTED_EVIDENCE` and
 * `SETUP_STEP_PANES` are all exhaustive Records for the same reason), so a new
 * step fails the typecheck here until a person decides which side of the line it
 * is on. The cost is one field on twenty declarations, paid once.
 *
 * **Why a field and not an exclusion set in the traversal.** An exclusion set
 * was the cheaper option and it is rejected on this registry's own founding rule
 * ("Derived, not parallel"): it is a second list, in exactly the shape the flat
 * array was, and it would be UNREACHABLE from three places that need the
 * answer — `buildSetupReadiness`, the setup-progress route's validator, and
 * `npm run setup:check` — so "may an operator confirm this?" would have three
 * answers depending on which module you asked.
 *
 * **It is a plain string literal**, deliberately, so `npm run setup:check` (a
 * `tsx` entrypoint) imports this module as happily as the React tree does. This
 * is why `kind` lives here and `SETUP_STEP_PANES` — which carries
 * `ComponentType`s — could not.
 */
export type SetupStepKind = "operator" | "environment";

/**
 * WHETHER THIS ENTRY CAN HOLD THE PUBLISH BUTTON SHUT (epic #213, **D17**, C15
 * #246).
 *
 * Three of the five environment facts describe a deployment a club must not
 * open its public site on top of: nothing has declared whether this
 * installation is the live site or a copy, a required runtime variable is
 * missing or malformed, or the auth secret is weak enough that the site cannot
 * store a Stripe or Xero credential. The other two — email transport and
 * Sentry — are worth an amber row and nothing more.
 *
 * - `none` — this entry never holds publish shut. Every operator step
 *   (`allResolved` is the gate that speaks for those — D9 keeps the three facts
 *   separate and this must not re-merge them) and the two advisory facts.
 * - `blocks-until-complete` — while this fact's readiness check is anything
 *   other than `complete`, `launchBlockedBy` names it and the launch panel
 *   refuses to publish.
 *
 * **`!== "complete"` is the whole predicate, and it lands exactly on the three
 * conditions D17 names** rather than approximating them: `runtime-env` is
 * `complete` iff no variable is missing or malformed; `auth-secret-strength` is
 * `complete` iff the secret is not weak; `environment-role` is `complete` for
 * both confirmed roles and `blocked` for UNKNOWN. Its one other branch —
 * "database state was not checked" — needs `db` to be absent, which only
 * `npm run setup:check` without database access produces and the wizard's own
 * payload never can. That branch therefore fails closed on a path the publish
 * button cannot be reached from, which is the harmless direction.
 *
 * **REQUIRED on every entry, like `kind`, and for the same reason.** The unsafe
 * silence here is the opposite of the one `kind` guards: a defaulted `none`
 * would let somebody add a genuine launch precondition and have it quietly not
 * gate anything. `findSetupStepRegistryViolations` additionally refuses an
 * OPERATOR step that claims to gate launch — that question is `allResolved`'s,
 * and a step answering it twice is D14's one-number-two-meanings defect a layer
 * up.
 */
export type SetupStepLaunchGate = "none" | "blocks-until-complete";

/**
 * The shape a definition is authored in. `id` and `prerequisites` are `string`
 * rather than `SetupStepId` because `SetupStepId` is derived FROM the
 * definitions — narrowing them here would be circular. `SetupStepEntry` below is
 * the narrowed view every reader should use.
 */
export interface SetupStepDefinition {
  readonly id: string;
  readonly ownerModule: SetupStepOwner;
  /** Operator step or deployment fact — see {@link SetupStepKind}. */
  readonly kind: SetupStepKind;
  /** Whether this entry can hold publish shut — see {@link SetupStepLaunchGate}. */
  readonly launchGate: SetupStepLaunchGate;
  readonly prerequisites: readonly string[];
  readonly order: number;
  readonly completion: SetupStepCompletionSource;
}

// Written as a generic mapped type on purpose: that form is homomorphic, so it
// maps a tuple to a TUPLE (preserving arity and each element's literal type)
// instead of mapping every key of an array — including `length` and `map`.
type SetupStepIdsOf<Definitions extends readonly SetupStepDefinition[]> = {
  [Index in keyof Definitions]: Definitions[Index]["id"];
};

type SetupStepIdTuple = SetupStepIdsOf<typeof SETUP_STEP_DEFINITIONS>;

/**
 * Every setup step id, in presentation order. Same name, same tuple type and
 * same order as the hand-maintained array this replaced, so every consumer —
 * `z.enum` in the setup-progress route, `SetupStepId`, the progress
 * normaliser — is untouched.
 */
// `Array.prototype.map` cannot return a tuple type, so the arity has to be
// asserted. It is the only unchecked step in the derivation, and
// `setup-step-registry.test.ts` covers it by comparing this value element by
// element against the declarations it came from.
export const SETUP_STEP_IDS = SETUP_STEP_DEFINITIONS.map(
  (definition) => definition.id,
) as unknown as SetupStepIdTuple;

export type SetupStepId = SetupStepIdTuple[number];

export interface SetupStepEntry extends SetupStepDefinition {
  readonly id: SetupStepId;
  readonly prerequisites: readonly SetupStepId[];
}

export const SETUP_STEP_REGISTRY: readonly SetupStepEntry[] =
  SETUP_STEP_DEFINITIONS;

/**
 * The status/progress pair `buildSetupReadiness` computes for a step. Declared
 * here rather than imported from `setup-readiness.ts` so the registry stays free
 * of an import cycle with the module that derives `SETUP_STEP_IDS` from it;
 * `setup-step-registry.test.ts` pins the two together behaviourally by counting
 * a real readiness result with `resolveSetupStepCompletion` and comparing that
 * to the readiness summary's own `complete` figure.
 */
export interface SetupStepCompletionInput {
  readonly status: "complete" | "warning" | "blocked" | "not_started";
  readonly progress: "open" | "completed" | "skipped";
}

/**
 * The TWO answers a step's completion question has, kept apart (epic #213
 * **D14**).
 *
 * Until #237 there was one answer and one predicate — `isSetupStepComplete`,
 * `status === "complete" || progress === "completed"` — which made a passing
 * readiness check and an operator's own record INTERCHANGEABLE evidence. They
 * are not the same claim, and treating them as one is what let a fresh seed
 * open the wizard 56% of the way through a journey nobody had walked: the seed
 * writes defaults, the defaults satisfy nine checks, and the wizard reported
 * that as progress. D14 splits them and counts only the operator's record.
 *
 * - `derivedSatisfied` — the step's own readiness check passes. Nobody said so;
 *   the system worked it out. It is a real fact and it is shown (the wizard's
 *   "defaulted" state), but it is not a confirmation and it does not count
 *   toward D7's percentage.
 * - `operatorConfirmed` — a person marked this step done. This is the one that
 *   counts, and it is the only one that does.
 *
 * SKIPPING IS NEITHER. "Skip for now" is D4's deferral: it buys passage past a
 * step and leaves it visibly outstanding, so it neither confirms the step nor
 * says anything about whether the check passes.
 */
export interface SetupStepCompletionAnswer {
  readonly derivedSatisfied: boolean;
  readonly operatorConfirmed: boolean;
}

/**
 * Resolve both halves of {@link SetupStepCompletionAnswer} for one step.
 *
 * ONE function returning both rather than two predicates, so the exhaustiveness
 * guard below is written once and a second `completion` source cannot be
 * handled in one half and forgotten in the other.
 *
 * Takes the LOOSE `SetupStepDefinition` shape rather than the narrowed
 * `SetupStepEntry` (widened by #219, C4). It reads only `completion`, and the
 * traversal layer runs it over synthetic registries whose ids are not
 * `SetupStepId` — the same reason `findSetupStepRegistryViolations` below takes
 * the loose shape. Every existing caller passes an entry, which still satisfies
 * this.
 *
 * ## The readiness summary did NOT move with this split (#237)
 *
 * `buildSetupReadiness`'s `summary.complete` still counts
 * `status === "complete" || progress === "completed"` — which is exactly the
 * UNION of the two answers here. That is deliberate and the pin in
 * `setup-step-registry.test.ts` is re-drawn over the union rather than deleted:
 * `/admin/setup`'s cards and `npm run setup:check` answer "is this installation
 * configured?", where a defaulted timezone genuinely IS configured, while the
 * wizard answers "has the operator been through this?". D14 exists to stop
 * those two questions sharing one number; making the readiness figure follow
 * the wizard's answer would have re-merged them one layer down.
 */
export function resolveSetupStepCompletion(
  entry: SetupStepDefinition,
  input: SetupStepCompletionInput,
): SetupStepCompletionAnswer {
  switch (entry.completion) {
    case "readiness-check":
      return {
        derivedSatisfied: input.status === "complete",
        operatorConfirmed: input.progress === "completed",
      };
    default: {
      // Exhaustiveness guard: `tsconfig` has neither `noImplicitReturns` nor a
      // switch-exhaustiveness lint rule, so nothing else fails the build the
      // day `SetupStepCompletionSource` gains a second member. This assignment
      // is the guard — a new member makes `entry.completion` fail to narrow to
      // `never` here, which is a typecheck error at THIS switch rather than a
      // silently-`undefined` return discovered in production.
      const _exhaustive: never = entry.completion;
      throw new Error(
        `Unhandled setup step completion source: ${String(_exhaustive)}`,
      );
    }
  }
}

/**
 * The step ids that apply to a club with these module flags, in presentation
 * order. `moduleSettings` is the `adminModuleSettings` field of
 * `SetupDatabaseSnapshot`, and its three states are NOT interchangeable:
 *
 * - `undefined` — module state is UNKNOWN. No snapshot was taken at all: a
 *   DB-less `npm run setup:check` (`scripts/setup.ts` passes none), or a caller
 *   older than this field. Applicability FAILS OPEN and every step is returned.
 *   Excluding a step here would hide setup work from an operator on the exact
 *   run that could not see the club's configuration, which is the wrong
 *   direction to be wrong in: a step shown unnecessarily costs a glance, a step
 *   hidden wrongly is never done.
 * - `null` — the club has no saved `ClubModuleSettings` row. That is a KNOWN
 *   answer, not a missing one: it resolves to the first-install defaults, the
 *   same reading `buildModuleLayerState` and `formatModuleActivationDetail`
 *   already take in `setup-readiness.ts` ("first-install defaults until settings
 *   are saved"). Under `DEFAULT_MODULE_SETTINGS` SEVENTEEN modules are off
 *   (counted directly from `src/config/modules.ts`'s `false` entries), but
 *   only three of them — `addressAutocomplete`, `xeroIntegration` and
 *   `financeDashboard` — own a setup step, so it is those three modules' four
 *   owned steps (`xeroIntegration` owns two) that are excluded.
 * - a record — the club's saved flags, used as given. This function's
 *   signature takes the full `ModuleSettingsValues` record (or `null`/
 *   `undefined`), never a `Partial` one — the type checker rejects a partial
 *   object here. `normalizeClubModuleSettings` still runs on it because ITS
 *   OWN signature accepts `Partial<ClubModuleSettingsRecord> | null |
 *   undefined`: it fills any key a caller further upstream left unset from
 *   module defaults internally, exactly like every other reader of
 *   `ClubModuleSettings`.
 */
export function getApplicableSetupStepIds(
  moduleSettings?: ModuleSettingsValues | null,
): SetupStepId[] {
  if (moduleSettings === undefined) {
    return SETUP_STEP_REGISTRY.map((entry) => entry.id);
  }

  const flags = normalizeClubModuleSettings(moduleSettings);
  return SETUP_STEP_REGISTRY.filter(
    (entry) =>
      entry.ownerModule === CORE_STEP_OWNER || flags[entry.ownerModule],
  ).map((entry) => entry.id);
}

/**
 * How a collision message refers to one declarer. `core` is not a module —
 * it is this registry's own definitions file, not an entry in
 * `MODULE_DEFINITIONS` — so it is named "the core registry" rather than
 * `module "core"`, which would misdescribe it as one of the modules it is
 * being distinguished from.
 */
function describeStepOwner(owner: SetupStepOwner): string {
  return owner === CORE_STEP_OWNER
    ? "the core registry"
    : `module "${owner}"`;
}

/**
 * Every way a registry can be malformed, as messages NAMING the offending step
 * ids. Exported over an assertion so a test can feed it a synthetic bad registry
 * and read what it says; the real registry is checked by the contract test.
 *
 * Takes the loose `SetupStepDefinition` shape on purpose: the narrowed
 * `SetupStepEntry` type already makes an unknown prerequisite id a type error,
 * so a validator that only accepted entries could never be shown the failure it
 * exists to catch.
 *
 * SCOPED TO THE ARGUMENT, DELIBERATELY. Every check reads only the definitions
 * it was handed; no other registry is consulted. Step ids are namespaced by
 * their registry, and ids DO repeat across namespaces already —
 * `config-self-heal-steps.ts` declares a self-heal step named `club-time-zone`,
 * byte-identical to this registry's 2nd id and entirely unrelated to it.
 * Treating that as a collision would fail the build over two files that never
 * meet. Cross-registry collision WITHIN this one namespace is exactly what the
 * duplicate-id check below catches now that modules contribute their own steps
 * (epic #213, C3 #218) — it names both declaring `ownerModule`s so a
 * cross-module clash reads as "module A and module B both claimed this id",
 * not merely "this id is duplicated somewhere".
 */
export function findSetupStepRegistryViolations(
  definitions: readonly SetupStepDefinition[],
): string[] {
  const violations: string[] = [];

  // Tracks the FIRST definition seen for each id (not just whether the id has
  // been seen) so a collision message can name both declarers — the module
  // that owns the id already, and the module that just tried to reuse it
  // (epic #213, C3 #218). `core` is not a module — it is the registry's own
  // definitions file — so `describeStepOwner` below names it as "the core
  // registry" rather than `module "core"`, which would misdescribe a
  // core/core or core/module collision as a clash between two modules.
  const seen = new Map<string, SetupStepDefinition>();
  for (const definition of definitions) {
    const first = seen.get(definition.id);
    if (first) {
      violations.push(
        `Duplicate setup step id: "${definition.id}" declared by ${describeStepOwner(first.ownerModule)} and ${describeStepOwner(definition.ownerModule)}`,
      );
    } else {
      seen.set(definition.id, definition);
    }
  }

  // Degenerate ids and orders would otherwise pass every check below
  // silently — an empty/whitespace id still "matches" as a prerequisite
  // string comparison, and a non-finite order still compares with `<=`
  // (always false against NaN, always true against Infinity) without ever
  // reporting anything. The registry has no other layer that would catch
  // either: the type-level non-empty-tuple assertion covers an EMPTY
  // registry, not a malformed entry inside a non-empty one.
  for (const definition of definitions) {
    if (definition.id.trim().length === 0) {
      violations.push(
        `Setup step id "${definition.id}" is empty or whitespace-only`,
      );
    }
    if (!Number.isFinite(definition.order)) {
      violations.push(
        `Setup step "${definition.id}" has a non-finite order (${definition.order})`,
      );
    }
  }

  for (const definition of definitions) {
    for (const prerequisite of definition.prerequisites) {
      if (!seen.has(prerequisite)) {
        violations.push(
          `Setup step "${definition.id}" declares unknown prerequisite "${prerequisite}"`,
        );
      }
    }
  }

  // Positional derivation means a mis-sorted `order` silently ships the wrong
  // journey order rather than the declared one, so disagreement is a violation
  // and not a warning.
  for (let index = 1; index < definitions.length; index += 1) {
    const previous = definitions[index - 1];
    const current = definitions[index];
    if (current.order <= previous.order) {
      violations.push(
        `Setup step "${current.id}" (order ${current.order}) is declared after "${previous.id}" (order ${previous.order}) but does not sort after it`,
      );
    }
  }

  // A prerequisite must be presented BEFORE its dependent, because the
  // wizard shell never lets an operator jump forward (D2). A prerequisite
  // whose own `order` is not strictly less than its dependent's is a step the
  // operator could reach the dependent from without ever having seen the
  // prerequisite — unreachable, not just out of order.
  const definitionsById = new Map<string, SetupStepDefinition>(
    definitions.map((definition) => [definition.id, definition]),
  );
  for (const dependent of definitions) {
    for (const prerequisiteId of dependent.prerequisites) {
      const prerequisite = definitionsById.get(prerequisiteId);
      // Unknown prerequisites are already reported above; skip so one bad id
      // is not also announced as a forward reference.
      if (!prerequisite) continue;
      if (prerequisite.order >= dependent.order) {
        violations.push(
          `Setup step "${dependent.id}" (order ${dependent.order}) depends on prerequisite "${prerequisite.id}" (order ${prerequisite.order}), which is presented after its dependent; unreachable under the wizard's no-jumping-forward navigation`,
        );
      }
    }
  }

  // A prerequisite from a DIFFERENT, switchable module is a trap: the
  // dependent can be applicable (its own module on) while the prerequisite's
  // module is off, so the prerequisite would never be satisfiable. `core`
  // prerequisites are always safe because `core` steps are never excluded by
  // applicability; a same-module prerequisite is safe because both steps
  // disappear together when that module is off.
  for (const dependent of definitions) {
    for (const prerequisiteId of dependent.prerequisites) {
      const prerequisite = definitionsById.get(prerequisiteId);
      if (!prerequisite) continue;
      const prerequisiteModuleIsSafe =
        prerequisite.ownerModule === CORE_STEP_OWNER ||
        prerequisite.ownerModule === dependent.ownerModule;
      if (!prerequisiteModuleIsSafe) {
        violations.push(
          `Setup step "${dependent.id}" (module "${dependent.ownerModule}") depends on prerequisite "${prerequisite.id}" (module "${prerequisite.ownerModule}"): the dependent can be applicable while its prerequisite's module is disabled`,
        );
      }
    }
  }

  // D17 (#246): an `environment` entry has LEFT the journey — it is not on the
  // rail, the operator cannot confirm it, and the progress route refuses every
  // transition on it. So it can be neither end of a prerequisite edge, and both
  // directions are a genuine trap rather than a tidiness rule:
  //
  // - An operator step that DEPENDS on an environment fact is unfinishable
  //   through the wizard. Staleness is computed from "is my prerequisite
  //   confirmed?", nobody can ever confirm an environment fact, and no screen in
  //   the wizard offers a control that would — so the dependent goes stale the
  //   moment it is confirmed and stays stale forever, with nothing an operator
  //   can do about it. That is worse than the wrong journey order: it is a
  //   journey with no end.
  // - An environment fact that DECLARES a prerequisite is asserting an ordering
  //   over something that has no position in the journey to be ordered against.
  //   The panel renders every fact at once.
  //
  // Every prerequisite list is empty today, so this guards the future rather
  // than the present — which is the cheapest moment to write it, because there
  // is no existing edge to argue about.
  // D9 keeps setup-done, site-visible and environment-role separate, and the
  // publish gate is the place they could most easily be re-merged. An operator
  // step that claimed to gate launch would be answering `allResolved`'s
  // question a second time, in a second place, with a second predicate — which
  // is D14's one-number-two-meanings defect one layer up.
  for (const definition of definitions) {
    if (
      definition.kind === "operator" &&
      definition.launchGate !== "none"
    ) {
      violations.push(
        `Setup step "${definition.id}" is an operator step but declares launchGate "${definition.launchGate}"; whether operator steps hold publish shut is allResolved's question, and only an environment fact may gate launch separately (D9/D17)`,
      );
    }
  }

  for (const definition of definitions) {
    if (definition.kind !== "environment") continue;
    if (definition.prerequisites.length > 0) {
      violations.push(
        `Setup step "${definition.id}" is an environment fact but declares prerequisites (${definition.prerequisites.join(", ")}); an environment fact has no position in the journey to order against`,
      );
    }
  }
  for (const dependent of definitions) {
    for (const prerequisiteId of dependent.prerequisites) {
      const prerequisite = definitionsById.get(prerequisiteId);
      // Unknown prerequisites are already reported above.
      if (!prerequisite) continue;
      if (prerequisite.kind === "environment") {
        violations.push(
          `Setup step "${dependent.id}" depends on prerequisite "${prerequisite.id}", which is an environment fact: nobody can confirm an environment fact, so the dependent would go stale on it permanently`,
        );
      }
    }
  }

  violations.push(...findPrerequisiteCycles(definitions));

  return violations;
}

/**
 * Strongly-connected-component search over the prerequisite graph (Tarjan's
 * algorithm), not a plain DFS. A DFS that settles a node the first time it
 * finishes exploring it can walk into that settled node again from a SECOND
 * path and stop right there without ever re-opening it — so a step can sit
 * inside a genuine cycle and still never appear in any reported message. That
 * is not hypothetical: `s0 -> [s1, s2]`, `s1 -> [s0]`, `s2 -> [s1]` is one
 * three-member cycle (s0 and s2 are mutually reachable via s1), but a
 * settled-early-return DFS visits s0, then s1 (which closes a cycle back to
 * s0 and reports `s0 -> s1 -> s0`), marks s1 settled, then reaches s2, whose
 * only prerequisite is the now-settled s1 — so the walk stops there and s2 is
 * never named. Tarjan's algorithm does not have this hole: it computes the
 * graph's strongly-connected components directly, and every step that is
 * mutually reachable with another step ends up in the same component
 * regardless of which node the search started from or in what order.
 *
 * A violation is a component of size > 1 (every member can reach every other
 * member, i.e. a genuine cycle), OR a size-1 component whose single step
 * lists itself as its own prerequisite (a one-step cycle). A size-1
 * component with no self-loop is just a step with no cyclic prerequisite and
 * is not reported. Each violation message lists the full, SORTED member set
 * of its component, so the same cluster reads identically no matter which
 * step's declaration order happened to discover it first — determinism the
 * old path-based messages ("a -> b -> c -> a") could not offer once the
 * reporting path itself became ambiguous.
 *
 * Duplicate ids: `prerequisitesById` below is built by `Map`, which resolves
 * a duplicate key last-wins — so if two definitions share an id, only the
 * LAST one's prerequisite edges are visible to this analysis; the first
 * duplicate's own edges are dropped. That is acceptable because a duplicate
 * id is already its own violation (see the id-uniqueness check above), which
 * always fires alongside — this function never has to be the one to catch
 * it, and a silently-dropped edge from a definition that is itself invalid
 * cannot hide a real cycle from the rest of a well-formed registry.
 */
function findPrerequisiteCycles(
  definitions: readonly SetupStepDefinition[],
): string[] {
  const prerequisitesById = new Map<string, readonly string[]>(
    definitions.map((definition) => [definition.id, definition.prerequisites]),
  );

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  const strongConnect = (id: string): void => {
    index.set(id, counter);
    lowlink.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);

    for (const prerequisite of prerequisitesById.get(id) ?? []) {
      // An unknown prerequisite is already reported by the check above;
      // skipping it here keeps one bad id from also being announced as part
      // of a cycle.
      if (!prerequisitesById.has(prerequisite)) continue;

      if (!index.has(prerequisite)) {
        strongConnect(prerequisite);
        lowlink.set(
          id,
          Math.min(lowlink.get(id) as number, lowlink.get(prerequisite) as number),
        );
      } else if (onStack.has(prerequisite)) {
        lowlink.set(
          id,
          Math.min(lowlink.get(id) as number, index.get(prerequisite) as number),
        );
      }
    }

    if (lowlink.get(id) === index.get(id)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop() as string;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      components.push(component);
    }
  };

  for (const definition of definitions) {
    if (!index.has(definition.id)) strongConnect(definition.id);
  }

  const cycles = components
    .filter((component) => {
      if (component.length > 1) return true;
      const [only] = component;
      return (prerequisitesById.get(only) ?? []).includes(only);
    })
    .map((component) => {
      const members = [...component].sort();
      return `Setup step prerequisite cycle: ${members.join(", ")}`;
    });

  // Component discovery order depends on Tarjan's traversal, not on any
  // property of the registry itself, so sort the final messages too — the
  // same malformed registry must always report its violations in the same
  // order.
  cycles.sort();

  return cycles;
}
