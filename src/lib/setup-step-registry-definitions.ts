import {
  ADDRESS_AUTOCOMPLETE_SETUP_STEPS,
  FINANCE_DASHBOARD_SETUP_STEPS,
  XERO_INTEGRATION_SETUP_STEPS,
} from "@/config/modules";
import type { SetupStepDefinition } from "@/lib/setup-step-registry";

/**
 * The registered setup step DEFINITIONS (epic #213, children C1 and C3).
 *
 * Split out of `setup-step-registry.ts`, which holds the contract, the derived
 * id tuple, the applicability rule and the guards. The two files answer
 * different questions — "what is a step, and what is guaranteed about the set?"
 * there, "which steps exist, who owns each one, and in what order?" here.
 *
 * READ `setup-step-registry.ts`'s module doc FIRST. It states the guarantees
 * every definition below has to satisfy, and — importantly — that this array's
 * ORDER is load-bearing: `SETUP_STEP_IDS` is derived from it positionally, so
 * the array must stay sorted by `order` and a step may only be moved by moving
 * its entry, never by editing `order` alone.
 *
 * ## This file now holds CORE steps only (C3, #218)
 *
 * C1 declared every step here, including the four module-owned ones
 * (`address-autocomplete`, `xero-operational`, `finance-dashboard`,
 * `xero-mappings`). C3 moved those four INTO their owning modules'
 * `MODULE_DEFINITIONS` entries in `src/config/modules.ts` — a module now
 * declares its own wizard steps where it declares itself, so a new module
 * cannot gain a flag and forget to register with setup. This file assembles:
 * the fourteen `core` definitions below, in their existing order, plus each
 * module's exported step array APPENDED after them. "Spliced in at its
 * correct `order` position" describes an append today, not an interleave:
 * every module-owned `order` (140-170) sits above core's max (130), so no
 * core entry has to move to make room. A module step whose `order` belonged
 * BETWEEN two core entries would need the `CORE_SETUP_STEP_DEFINITIONS`
 * spread below chunked around it by hand — nothing here does that
 * automatically — and the order-vs-position guard in
 * `findSetupStepRegistryViolations` fails loudly on the resulting
 * order/position mismatch if someone tries to insert one without doing so.
 *
 * **The amended AC1 reading (owner decision, 25 Aug, on #218):** the original
 * "no change to setup code" criterion is unreachable literally — a module's
 * step has to reach this array somehow. Its enforceable spirit instead: a
 * module's steps are DECLARED in the module's own definition
 * (`src/config/modules.ts`), and the one remaining registry edit is this
 * file's hand splice — a single, CI-guarded line per module, not a change to
 * the registry's contract, its guards, or any other module's entry. A
 * module's declared steps can never silently fail to appear: forgetting the
 * splice line is a build failure (the parity scan below), not a runtime
 * absence a wizard user would discover the hard way.
 *
 * The splice is written OUT BY HAND below rather than computed by iterating
 * every module generically. That is a deliberate, documented trade against
 * TypeScript's type system, not an oversight: `SETUP_STEP_IDS` must stay a
 * literal tuple type (`setup-step-registry.test.ts`, "the derived export is a
 * literal tuple" — a widened `string` would let the setup-progress route's
 * `z.enum` accept any string as a step id while every runtime assertion still
 * passed). A literal tuple can only be built from a static `as const` spread —
 * `Array.prototype.flatMap`/`.sort()` over `MODULE_DEFINITIONS` would produce a
 * type-widened `SetupStepDefinition[]`, silently degrading that guarantee. The
 * safety net for a mis-spliced or forgotten module step is therefore a TEST,
 * not the type system, and it is a WIRING net rather than a content net:
 * `setup-step-registry.test.ts` ("matches a generic scan of MODULE_DEFINITIONS")
 * independently walks `MODULE_KEYS`/`MODULE_DEFINITIONS` and asserts the FULL
 * entry — id, order, ownerModule, prerequisites, completion — equals the
 * shipped `SETUP_STEP_REGISTRY` exactly. That catches a module step missing
 * from the splice, mis-owned, mis-ordered, or diverging in any field from the
 * module's own declaration (a prerequisite or completion source injected only
 * at the splice point). It does NOT independently verify that the ordering
 * itself is editorially right, or that the order-vs-position guard still
 * fires on a genuine collision — those remain the job of
 * `findSetupStepRegistryViolations` and the pinned `EXPECTED_STEP_IDS`/
 * applicability fixtures elsewhere in that file.
 *
 * `order` values are spaced by 10 so a later child (C3 onwards) can insert a
 * step without renumbering eighteen entries in a file several lanes are
 * editing at once. Nothing reads the numbers themselves; only their relative
 * order is meaningful. `environment-role` is the first entry to use that gap: it
 * arrived on `main` (ENV-SAFETY 1, #3034) as an eighteenth id in the flat array
 * this file replaced, positioned THIRD, and it takes `order: 25` here so it keeps
 * that position without a single other entry being renumbered — which is the
 * whole reason for the gaps. `site-style` (epic #213, C7, #222) is the second
 * use of it: `order: 105` slots it between `seasons-rates` (100) and `stripe`
 * (110) with nothing else renumbered.
 *
 * PREREQUISITES ARE EMPTY, DELIBERATELY. Epic #213's open question 1 asked
 * whether genuine prerequisites exist among the current steps. They do not: no
 * step's status is computed from another step's status or output. Every step
 * reads `SetupDatabaseSnapshot` fields and the environment directly. The
 * closest call is Finance Dashboard, which reads the same
 * `operationalXeroConnected` snapshot field the Operational Xero step reads —
 * but it reads the FIELD, not that step's verdict, so it is not a prerequisite.
 * Do not encode the editorial ordering of the journey as prerequisites: that is
 * what `order` is for, and a false prerequisite would block navigation (D2) on
 * a step an operator has no reason to complete first.
 */
const CORE_SETUP_STEP_DEFINITIONS = [
  {
    id: "club-config",
    // The bare literal, not the exported `CORE_STEP_OWNER` constant, is
    // deliberate: this file's module doc says it imports only a TYPE from
    // `setup-step-registry.ts` so the two modules have no runtime import
    // cycle. `CORE_STEP_OWNER` is a VALUE — importing it here would create
    // exactly that cycle, since `setup-step-registry.ts` imports
    // `SETUP_STEP_DEFINITIONS` from this file. Every `ownerModule: "core"`
    // below is the same deliberate literal.
    ownerModule: "core",
    prerequisites: [],
    order: 10,
    completion: "readiness-check",
  },
  {
    id: "club-time-zone",
    ownerModule: "core",
    prerequisites: [],
    order: 20,
    completion: "readiness-check",
  },
  {
    // Whether this installation is the club's live site or a copy
    // (ENV-SAFETY 1, #3034; INV-CONFIG-003). `core`, and it must stay `core`: no
    // module flag governs it, and the answer decides whether real members can be
    // emailed at all — a club that switched this step off by disabling a module
    // would be switching off the one question that stops a copy mailing the
    // membership.
    //
    // No prerequisites, for the reason the module doc gives: the readiness check
    // reads the resolved role off the snapshot directly, not another step's
    // verdict. It sits third because that is where `main` shipped it in the flat
    // array — immediately after the two club-identity steps and before the rest
    // of the environment ones.
    id: "environment-role",
    ownerModule: "core",
    prerequisites: [],
    order: 25,
    completion: "readiness-check",
  },
  {
    id: "runtime-env",
    ownerModule: "core",
    prerequisites: [],
    order: 30,
    completion: "readiness-check",
  },
  {
    id: "auth-secret-strength",
    ownerModule: "core",
    prerequisites: [],
    order: 40,
    completion: "readiness-check",
  },
  {
    id: "seed-admin",
    ownerModule: "core",
    prerequisites: [],
    order: 50,
    completion: "readiness-check",
  },
  {
    // The Modules page itself. It is `core` and must stay `core`: it is where a
    // module is switched on, so making it owned by any module would let a club
    // switch off the only step that can switch it back on.
    id: "feature-flags",
    ownerModule: "core",
    prerequisites: [],
    order: 60,
    completion: "readiness-check",
  },
  {
    id: "booking-policies",
    ownerModule: "core",
    prerequisites: [],
    order: 70,
    completion: "readiness-check",
  },
  {
    id: "membership-cancellation",
    ownerModule: "core",
    prerequisites: [],
    order: 80,
    completion: "readiness-check",
  },
  {
    id: "age-tiers",
    ownerModule: "core",
    prerequisites: [],
    order: 90,
    completion: "readiness-check",
  },
  {
    id: "seasons-rates",
    ownerModule: "core",
    prerequisites: [],
    order: 100,
    completion: "readiness-check",
  },
  {
    // The public website's colours, fonts and logo (epic #213, C7; issue #222).
    // `core`: no module flag governs a club's own site branding — every club has
    // a public site to style. Positioned between the booking-rules steps and the
    // operational integrations, matching where the epic's mockups placed "Look &
    // feel" in the journey (screen 4). `order: 105` sits it in the gap between
    // `seasons-rates` (100) and `stripe` (110) without renumbering either.
    //
    // Deliberately does NOT depend on anything: `buildWebsiteStylingCheck` in
    // `setup-readiness.ts` derives completion from the theme's own persisted
    // values, never from `ClubTheme.completedAt` — that field is the site-launch
    // lever, owned exclusively by the wizard's launch panel (D9), and a styling
    // step that read it would make finishing this step depend on an action it is
    // explicitly forbidden from taking.
    id: "site-style",
    ownerModule: "core",
    prerequisites: [],
    order: 105,
    completion: "readiness-check",
  },
  {
    // `core`, not a module: there is no Stripe module flag. Card payment is the
    // default settlement path and `internetBankingPayments` is the ALTERNATIVE
    // path's flag, so it does not own this step.
    id: "stripe",
    ownerModule: "core",
    prerequisites: [],
    order: 110,
    completion: "readiness-check",
  },
  {
    id: "email-ses",
    ownerModule: "core",
    prerequisites: [],
    order: 120,
    completion: "readiness-check",
  },
  {
    id: "sentry",
    ownerModule: "core",
    prerequisites: [],
    order: 130,
    completion: "readiness-check",
  },
] as const satisfies readonly SetupStepDefinition[];

/**
 * The assembled registry: `CORE_SETUP_STEP_DEFINITIONS` above, plus each
 * module's own declared steps (`src/config/modules.ts`) spliced in at their
 * `order` position, with `ownerModule` supplied here — the one piece a module
 * declaration does not carry, because it is implied by which module is being
 * spliced in. See this file's module doc for why the splice is written out
 * rather than computed generically, and where the drift safety net lives.
 *
 * Every module-owned entry below is BYTE-IDENTICAL (id, order, ownerModule,
 * prerequisites, completion) to the one C1 declared inline here — this is a
 * pure relocation, not a behaviour change, and `setup-step-registry.test.ts`'s
 * C1 pins (`EXPECTED_STEP_IDS`, the `ownerModule` map, the applicability sets)
 * are unchanged and still green as the parity proof.
 */
export const SETUP_STEP_DEFINITIONS = [
  ...CORE_SETUP_STEP_DEFINITIONS,
  { ...ADDRESS_AUTOCOMPLETE_SETUP_STEPS[0], ownerModule: "addressAutocomplete" },
  { ...XERO_INTEGRATION_SETUP_STEPS[0], ownerModule: "xeroIntegration" },
  { ...FINANCE_DASHBOARD_SETUP_STEPS[0], ownerModule: "financeDashboard" },
  {
    // xero-mappings: owned by `xeroIntegration` even though
    // `buildXeroMappingCheck` consults no module flag today — account and item
    // mappings exist only to post to Xero, so with the module off there is
    // nothing for an operator to map. Nothing reads applicability yet (C1
    // wires none of it), so this declaration changes no card today; the
    // visible consequence lands with the child that wires the cards to the
    // registry (C8), where a Xero-disabled club stops being shown a mapping
    // card it can do nothing with. Flag it there rather than treating it as a
    // silent regression.
    ...XERO_INTEGRATION_SETUP_STEPS[1],
    ownerModule: "xeroIntegration",
  },
] as const satisfies readonly SetupStepDefinition[];
