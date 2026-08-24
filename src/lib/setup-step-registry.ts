import { type ModuleKey, type ModuleSettingsValues } from "@/config/modules";
import { normalizeClubModuleSettings } from "@/lib/module-settings";
import { SETUP_STEP_DEFINITIONS } from "@/lib/setup-step-registry-definitions";

/**
 * The setup step registry (epic #213, child C1).
 *
 * Replaces the hand-maintained `SETUP_STEP_IDS` array that used to live in
 * `setup-readiness.ts`. A step now DECLARES the module that owns it, the steps
 * it genuinely depends on, its presentation order, and how its completion is
 * determined; `SETUP_STEP_IDS` is derived from those declarations, so every
 * existing consumer keeps the same export, the same type and the same order.
 *
 * The definitions live in `setup-step-registry-definitions.ts`; this module
 * holds the contract, the derivation, the applicability rule and the guards.
 * Prior art for the split is `config-self-heal.ts` / `config-self-heal-steps.ts`,
 * which solves a different problem (silent repair of missing rows, not an
 * operator journey) with the same shape.
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
 * NOTHING IS WIRED TO APPLICABILITY YET. C1 is the substrate only, and its
 * acceptance criterion is that the readiness cards' step set is unchanged.
 * `getApplicableSetupStepIds` and `isSetupStepComplete` exist, are tested, and
 * have no production caller until C4/C8 introduce one.
 */

/** Owner value for a step that belongs to no module and can never be switched off. */
export const CORE_STEP_OWNER = "core";

export type SetupStepOwner = ModuleKey | typeof CORE_STEP_OWNER;

/**
 * How a step's completion is determined. One member today: every existing step
 * is decided by its own readiness check in `setup-readiness.ts`, keyed by the
 * same id. It is a union rather than a fixed rule so C3 can add a
 * module-contributed step whose completion comes from somewhere else without
 * touching the other declarations.
 */
export type SetupStepCompletionSource = "readiness-check";

/**
 * The shape a definition is authored in. `id` and `prerequisites` are `string`
 * rather than `SetupStepId` because `SetupStepId` is derived FROM the
 * definitions — narrowing them here would be circular. `SetupStepEntry` below is
 * the narrowed view every reader should use.
 */
export interface SetupStepDefinition {
  readonly id: string;
  readonly ownerModule: SetupStepOwner;
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
 * a real readiness result with `isSetupStepComplete` and comparing that to the
 * readiness summary's own `complete` figure.
 */
export interface SetupStepCompletionInput {
  readonly status: "complete" | "warning" | "blocked" | "not_started";
  readonly progress: "open" | "completed" | "skipped";
}

/**
 * Whether a step counts as complete. The `readiness-check` rule is exactly the
 * predicate `buildSetupReadiness` already uses for its `complete` summary
 * figure: the check passed on its own, OR the operator marked it done. Skipping
 * alone does not make a step complete — a check that already passes stays
 * complete even when deferred; epic #213 D4 keeps a deferred step that has NOT
 * yet passed outstanding, and only a disabled module removes a step altogether.
 */
export function isSetupStepComplete(
  entry: SetupStepEntry,
  input: SetupStepCompletionInput,
): boolean {
  switch (entry.completion) {
    case "readiness-check":
      return input.status === "complete" || input.progress === "completed";
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
 *   are saved"). Under `DEFAULT_MODULE_SETTINGS` ten modules are off, but only
 *   three of them — `addressAutocomplete`, `xeroIntegration` and
 *   `financeDashboard` — own a setup step, so it is those three modules' four
 *   owned steps (`xeroIntegration` owns two) that are excluded.
 * - a record — the club's saved flags, used as given. A `Partial` record (a
 *   caller that only ever writes the keys it touches) resolves its missing
 *   keys to module defaults through `normalizeClubModuleSettings`, exactly like
 *   every other reader of `ClubModuleSettings`.
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
 * byte-identical to this registry's 17th id and entirely unrelated to it.
 * Treating that as a collision would fail the build over two files that never
 * meet. Cross-registry collision within ONE namespace is C3's guard, when
 * modules start contributing their own steps, and it is namespace-scoped too.
 */
export function findSetupStepRegistryViolations(
  definitions: readonly SetupStepDefinition[],
): string[] {
  const violations: string[] = [];

  const seen = new Set<string>();
  for (const definition of definitions) {
    if (seen.has(definition.id)) {
      violations.push(`Duplicate setup step id: "${definition.id}"`);
    }
    seen.add(definition.id);
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

  violations.push(...findPrerequisiteCycles(definitions));

  return violations;
}

/**
 * Depth-first cycle search over the prerequisite graph. Reports each cycle once,
 * as the path that closes it, so the message names every step involved rather
 * than just the edge that tripped the detector. A step that lists itself is a
 * one-step cycle and is reported the same way.
 */
function findPrerequisiteCycles(
  definitions: readonly SetupStepDefinition[],
): string[] {
  const prerequisitesById = new Map<string, readonly string[]>(
    definitions.map((definition) => [definition.id, definition.prerequisites]),
  );
  const settled = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];
  const cycles: string[] = [];
  const reported = new Set<string>();

  const visit = (id: string): void => {
    if (settled.has(id)) return;
    if (onPath.has(id)) {
      const closes = path.slice(path.indexOf(id));
      // Report a cycle once however many entry points reach it: key on the
      // SORTED member set (not the path itself) so the same loop, entered from
      // any of its members, resolves to the same key.
      const key = [...closes].sort().join(",");
      if (!reported.has(key)) {
        reported.add(key);
        cycles.push(
          `Setup step prerequisite cycle: ${[...closes, id].join(" -> ")}`,
        );
      }
      return;
    }

    onPath.add(id);
    path.push(id);
    for (const prerequisite of prerequisitesById.get(id) ?? []) {
      // An unknown prerequisite is already reported above; skipping it here
      // keeps one bad id from also being announced as a cycle.
      if (prerequisitesById.has(prerequisite)) visit(prerequisite);
    }
    path.pop();
    onPath.delete(id);
    settled.add(id);
  };

  for (const definition of definitions) visit(definition.id);

  return cycles;
}
