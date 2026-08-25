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
 * same id. It is a union rather than a fixed rule so a module-contributed step
 * (epic #213, child C3) could have its completion come from somewhere else
 * without touching the other declarations.
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
 *
 * Takes the LOOSE `SetupStepDefinition` shape rather than the narrowed
 * `SetupStepEntry` (widened by #219, C4). It reads only `completion`, and the
 * traversal layer runs it over synthetic registries whose ids are not
 * `SetupStepId` — the same reason `findSetupStepRegistryViolations` below takes
 * the loose shape. Every existing caller passes an entry, which still satisfies
 * this.
 */
export function isSetupStepComplete(
  entry: SetupStepDefinition,
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
