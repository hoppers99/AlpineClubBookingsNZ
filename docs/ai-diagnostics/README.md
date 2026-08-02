# AI Diagnostics — capability, configuration, metering, and rate limits (AID-2)

This is the operator- and developer-facing contract for the **AI Diagnostics**
capability delivered by AID-2 (issue #2371, epic #2369). It is a **separate,
admin-only, default-off paid product** from the page-help AI assistant
(`docs/…` on `aiAssistant` / `/api/help/chat`). The two share nothing at the
credential, budget, or metering layer.

> **ADR status.** The AID-1 threat model / ADR (#2370) was not yet delivered when
> this landed. AID-2 therefore implements the **safe defaults** the epic mandates
> and records the two decisions the ADR must ratify (see *Decisions the owner
> must confirm* below). No later child may weaken these contracts without an
> owner decision on-repo.

## What AID-2 delivers

- A **separate module/capability** — `aiDiagnostics` in `src/config/modules.ts`
  (default OFF), with its column on `ClubModuleSettings`.
- A **dedicated Anthropic credential** — provider `anthropic-diagnostics`, key
  `api_key`, in the encrypted `IntegrationCredential` store. NEVER the page-help
  `anthropic` key, and no fallback to it.
- A **deployment-local monthly budget** in NZ integer cents
  (`DiagnosticsSettings`, ships at **NZ$0 = hard-off**).
- **Concurrency-safe budget reservation** that reserves per provider roundtrip
  and bounds the multi-tool loop.
- **Fail-closed metering** with a circuit breaker.
- **Auth-sensitive rate limits** — per-admin, per-IP, and a global backstop.
- A **readiness** surface and **Full-Admin** credential/config management.

The diagnostics *product* itself (the deployed-knowledge bundle, structured page
context, SELECT-only tool substrate, tool packs, and UI) arrives in the later
children (AID-3…AID-8). AID-2 is the capability/config/metering/rate-limit
foundation those build on.

## Decisions the owner must confirm

1. **Dedicated credential vs reuse — implemented DEDICATED, flag for confirm.**
   Diagnostics uses its own Anthropic key under provider `anthropic-diagnostics`.
   This lets a deployment point diagnostics at a **separate Anthropic
   workspace/key** (separate billing, spend limits, and zero-retention posture),
   and guarantees a page-help key can never silently authorise diagnostics spend.
   This is the epic's "no implicit credential sharing" default. If the owner
   instead wants diagnostics to reuse the page-help key, that is a deliberate
   contract change to make on-repo in AID-1.

2. **Config-transfer travel — implemented NON-TRAVELLING, flag for confirm.**
   Diagnostics configuration does **not** ride config-transfer bundles between
   deployments:
   - the `aiDiagnostics` module flag is **excluded** from the travelling module
     set (like `magicLink`/`googleLogin`) — enabling a paid, separately-keyed
     product is a per-deployment decision;
   - `DiagnosticsSettings` (the budget) is **not registered** as a travelling
     singleton (mirrors `AiAssistantSettings`, and stricter — the NZ$0 default
     means an import can never plant a spend cap a target did not choose);
   - the three usage tables are runtime metering, never configuration;
   - the dedicated credential lives in the encrypted credential store, which is
     outside config-transfer entirely (secrets never travel).

   This is the epic's recommended default. Pinned by
   `config-transfer-club-settings.test.ts`.

## Module-off configuration reachability

Deliberate, and explicit:

- The **dedicated Anthropic key** is written/read on the shared, **ungated**
  `/api/admin/integrations/credentials` route (provider `anthropic-diagnostics`),
  so the highest-privilege secret can be entered **before** the module is on.
  Full-Admin only to write; any admin may read metadata-only status.
- The **readiness** endpoint `GET /api/admin/ai-diagnostics/readiness` is
  **exempt** from the module gate (same mechanism as the Lobby Display setup
  wizard), so an admin can see what is still missing — *module off*, *no
  dedicated key*, *no budget* — and finish setup before enabling. It spends
  nothing and exposes no secret value.
- The operational **budget settings** route `/api/admin/ai-diagnostics/settings`
  **hard-gates** on the module flag (exactly like
  `/api/admin/ai-assistant/settings`): a spend budget is meaningful only once the
  club has opted into the product by enabling the module, and enabling it alone
  authorises no spend (fail-closed readiness gates every paid call).

Route area: both `/admin/ai-diagnostics` and `/api/admin/ai-diagnostics` resolve
to the **`support`** admin permission area (`admin-permissions.ts`) — `view` =
readiness/status, `edit` = budget change; the dedicated key write stays Full-Admin
on the credentials route regardless of area level.

## Cost math

All money is **NZD integer cents**. The price table
(`AI_DIAGNOSTICS_PRICE_TABLE_NZ_CENTS_PER_MTOK` in `ai-diagnostics-usage.ts`) is
Anthropic's USD list prices × a deliberately conservative **FX of 1.8 NZD/USD**
(the same FX as page-help), so the estimate over-counts the true bill and the cap
trips early:

| Model | USD in/out/cache-write/cache-read per MTok | NZ cents in/out/cw/cr per MTok |
|---|---|---|
| `claude-opus-5` | $5.00 / $25.00 / $6.25 / $0.50 | 900 / 4500 / 1125 / 90 |
| `claude-sonnet-5` | $3.00 / $15.00 / $3.75 / $0.30 | 540 / 2700 / 675 / 54 |
| `claude-haiku-4-5` | $1.00 / $5.00 / $1.25 / $0.10 | 180 / 900 / 225 / 18 |

An **unknown** model is priced at the highest known row (fail-expensive), so a
model swap by a later child never silently under-counts. `estimateDiagnosticsCostCents`
`Math.ceil`s the summed per-token cost and bills at least 1 cent whenever any
usage is present (0 only for a token-free error). **UPDATE THIS TABLE** whenever
Anthropic changes prices or the FX drifts materially.

### Reservation size and the multi-tool loop

- `WORST_CASE_ROUNDTRIP_CENTS` (derived by `computeWorstCaseRoundtripCents`) is
  the amount reserved before **each** provider roundtrip. It prices
  `DIAGNOSTICS_MAX_INPUT_TOKENS_PER_ROUNDTRIP` (32k) input tokens at the more
  expensive of the plain-input and cache-write rates, plus
  `DIAGNOSTICS_MAX_OUTPUT_TOKENS_PER_ROUNDTRIP` (8k) output tokens, at the
  highest-priced model. With the table above that is **72 cents**.
- `DIAGNOSTICS_MAX_TOOL_ROUNDS` (8) bounds the loop, so a single session's
  worst-case spend is `rounds × worst-case-roundtrip` (~NZ$5.76), and the monthly
  budget bounds the sum across all sessions.
- The reservation is a pre-call ceiling; **post-call metering reconciles the
  actual (usually far smaller) cost** into `DiagnosticsUsageMonthly.settledCents`.

## Concurrency

The budget reserve is a **guarded claim under a per-month advisory lock** — see
`docs/CONCURRENCY_AND_LOCKING.md` → *Diagnostics budget reserve* for the full
argument. In short: `reserveDiagnosticsBudget` takes
`pg_advisory_xact_lock(hashtext('diagnostics-budget-reserve'), hashtext(<month>))`,
reclaims expired reservations, sums live reservations + settled spend, and
inserts a reservation only if the total stays within budget — all atomic against
concurrent reservers, so a burst cannot overspend the budget. The provider call
runs outside the transaction; `settleDiagnosticsRoundtrip` releases the
reservation and books the real cost afterwards, taking the **same** per-month
lock as its first statement so its reservation-delete + settled increment cannot
commit mid-reserve and under-count committed spend (reserve and settle mutually
exclude per month; each takes only this one key, so there is no lock-ordering
cycle); `expiresAt` reclaims a leaked reservation from a crashed call.

## Fail-closed points

Every gate denies the paid call on doubt:

- **Reserve** returns `metering_unavailable` on a missing delegate (blue/green
  old colour), a lock/read fault, or any thrown error — can't-prove-under-budget
  ⇒ don't-spend.
- **Metering circuit breaker** (`isDiagnosticsMeteringHealthy`) opens after
  `DIAGNOSTICS_METERING_FAILURE_THRESHOLD` (3) consecutive settle failures; the
  product route checks it BEFORE spending — can't-meter ⇒ don't-spend.
- **Readiness** (`getDiagnosticsReadiness`) returns `ready: false` with a
  `resolve_error` blocker on any DB fault rather than throwing.
- **Budget** defaults to NZ$0, so enabling the module alone authorises nothing.
- The **rate limiters** are all `authSensitive`, so a degraded shared-store
  fallback runs at limit/4 — a store outage tightens, never loosens, the
  paid-call backstop.

## Approved audit metadata only

`DiagnosticsUsageEvent` stores **only** approved metadata: month, acting
`adminMemberId` (plain string, no FK), surface, model, roundtrip index,
success/error metadata, token counts, cost, and a **redacted + truncated**
provider error message. It stores **NO** raw prompts, answers, tool
args/results, provider payloads, credentials, or unrestricted identifiers (epic
#2369 boundary). `DiagnosticsBudgetReservation`, `DiagnosticsUsageMonthly`, and
`DiagnosticsSettings` carry no member content at all.

## Data model & migration

Migration `20260802200000_add_ai_diagnostics_capability` (additive, blue/green
EXPAND — see the ledger row in `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`):

- `ClubModuleSettings.aiDiagnostics BOOLEAN NOT NULL DEFAULT false`
- `DiagnosticsSettings` (budget singleton, id `default`, budget default 0)
- `DiagnosticsUsageMonthly` (settled rollup, unique `month`)
- `DiagnosticsBudgetReservation` (live per-roundtrip reservations, `expiresAt`)
- `DiagnosticsUsageEvent` (approved-metadata event log)

No foreign keys (metering must never block a `Member` change), no seeded rows
(the settings singleton is created on first write, and a positive budget is a
deliberate act).

## Carry-forward

A deterministic multi-connection `.realdb` over-budget **race** test (two clients
latched on the advisory lock, mirroring
`concurrency-lock-races.realdb.test.ts`) is the ideal complement to the
exhaustive unit + wiring tests here; it needs a throwaway Postgres harness and is
recommended as a follow-up. The concurrency correctness is otherwise established
by the mutation-tested guard (`decideReservation`), the wiring test that proves
advisory-lock-first + read-live-reservations + guarded-insert + no-insert-on-loss,
and the documented lock argument above.
