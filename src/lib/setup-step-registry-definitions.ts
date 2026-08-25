import type { SetupStepDefinition } from "@/lib/setup-step-registry";

/**
 * The registered setup step DEFINITIONS (epic #213, child C1).
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
 * The only thing this file imports from the registry is a TYPE, which erases at
 * compile time, so the two modules have no runtime import cycle.
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
export const SETUP_STEP_DEFINITIONS = [
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
  {
    id: "address-autocomplete",
    ownerModule: "addressAutocomplete",
    prerequisites: [],
    order: 140,
    completion: "readiness-check",
  },
  {
    id: "xero-operational",
    ownerModule: "xeroIntegration",
    prerequisites: [],
    order: 150,
    completion: "readiness-check",
  },
  {
    id: "finance-dashboard",
    ownerModule: "financeDashboard",
    prerequisites: [],
    order: 160,
    completion: "readiness-check",
  },
  {
    // Owned by `xeroIntegration` even though `buildXeroMappingCheck` consults no
    // module flag today — account and item mappings exist only to post to Xero,
    // so with the module off there is nothing for an operator to map. Nothing
    // reads applicability yet (C1 wires none of it), so this declaration changes
    // no card today; the visible consequence lands with the child that wires the
    // cards to the registry (C8), where a Xero-disabled club stops being shown a
    // mapping card it can do nothing with. Flag it there rather than treating it
    // as a silent regression.
    id: "xero-mappings",
    ownerModule: "xeroIntegration",
    prerequisites: [],
    order: 170,
    completion: "readiness-check",
  },
] as const satisfies readonly SetupStepDefinition[];
