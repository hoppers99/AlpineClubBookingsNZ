# ADR-005: Budget, Rate Limits, Tool-Loop Bounds, and a Fail-Closed Control Plane

## Status

Accepted — the owner-ratified AID-1 foundation merged through PR #2529 on
2 August 2026.

**Governance:** no implementation child (#2371–#2379) may weaken the contract in
this ADR without an owner decision recorded on-repo.

## Context

Diagnostics spends real money on a paid model, and — unlike Page help's single
round-trip — a diagnostics answer may take **several** model round-trips as the
model requests tools, reads results, and continues. That multiplies both cost and
the blast radius of any fault. The Page help control plane already encodes the
right instincts and is the template: a monthly integer-cent budget that **fails
closed** (`checkAiBudget`, `src/lib/ai-assistant-usage.ts:157-187`), a
worst-case per-call reserve (`WORST_CASE_CALL_CENTS`, line 53), a metering
circuit breaker ("can't-meter ⇒ don't-spend", lines 193-206), three layered rate
limiters (per-IP, per-member, global backstop,
`src/app/api/help/chat/route.ts:114-142`), and a request timeout
(`AI_REQUEST_TIMEOUT_MS`, `anthropic-client.ts:27`). Diagnostics needs the same
shape, tightened for the multi-round tool loop and isolated from Page help's
budget (ADR-001).

## Decision

### 1. A dedicated monthly integer-cent budget, fail-closed

Diagnostics has its **own** monthly spend cap in NZD integer cents, separate from
Page help's, configured per deployment (ADR-006). The budget gate **fails
closed**: a missing settings row, a DB error, an unreadable ledger, or an unknown
model all deny the call (as `checkAiBudget` does today). Cost is over-counted
(conservative FX, `ceil`, fail-expensive for an unknown model) so the cap trips
early, not late.

### 2. A per-round-trip reserve, applied before every model call

Because one Diagnostics answer makes several provider round-trips, the worst-case
reserve is charged **per round-trip**, re-checked before each call in the loop —
not once per session. A session whose accumulated spend plus the next round-trip's
reserve would exceed the cap is stopped at that round-trip. The cap therefore
bounds a runaway *loop*, not just a runaway *request*.

### 3. The multi-tool loop is hard-bounded

The tool-use loop is bounded on every axis, all fail-closed:

- a **maximum number of rounds** per question (the model cannot loop
  indefinitely requesting tools);
- a **maximum number of tool calls** per round and per session;
- a **per-call and per-session wall-clock timeout** (extending
  `AI_REQUEST_TIMEOUT_MS`); a timeout stops the loop and is metered.

The exact numbers live in the capability/config layer (AID-2 #2371); this ADR
fixes that they exist, are finite, are enforced server-side, and cannot be raised
by anything in the request or in evidence (ADR-003).

### 4. Auth-sensitive rate limits: per-admin, per-IP, and global

Diagnostics carries its own three-layer limiter set, mirroring the Page help
route: **per-IP**, **per-admin**, and a **global backstop**, using the shared
`rate-limit.ts` store. They are marked auth-sensitive so the degraded-store mode
(`DEGRADED_AUTH_LIMIT_DIVISOR`, `docs/SECURITY-ATTACK-SURFACE.md`) cannot be used
to multiply a Diagnostics budget across replicas. The global limiter is a
`fallback`, not a hard error, so a spike degrades gracefully.

### 5. Fail-closed on every control: the exhaustive list

Diagnostics returns a structured, non-spending fallback (never a domain effect,
never an uncontrolled retry) on **any** of:

- **auth** failure — session invalid, admission denied, or a tool's fresh
  `area:view` re-check fails (ADR-002);
- **config** failure — module off, no usable credential, unreadable settings;
- **role** read failure — the effective permission matrix cannot be loaded (deny,
  do not assume yesterday's roles);
- **metering** failure — the circuit breaker is open ("can't-meter ⇒
  don't-spend");
- **budget** exhaustion — the cap (or the next round-trip's reserve) is reached;
- **timeout** — per-call or per-session wall-clock exceeded;
- **limit** — any rate limiter tripped, or any tool-loop bound reached.

Every stop is metered where a provider round-trip occurred, and audited with the
approved metadata set (ADR-004). No failure mode silently spends, silently
widens, or silently mutates.

## Consequences

### Positive

- A runaway loop, a role-load blip, a metering outage, or a spend spike all stop
  the same way: no spend, no data, a structured fallback — the money-safety
  posture the Page help lane proved.
- Diagnostics spend is capped and observable independently of Page help.

### Negative

- The per-round-trip reserve makes a legitimate long multi-tool session more
  likely to hit the cap than a single-shot call would; operators size the cap for
  the deeper workload (documented in the operator plan).
- Three limiters, a budget gate, a breaker, and loop bounds are more moving parts
  to test — mutation-tested guards are expected on each (AGENTS.md fast local
  gate).

## Related

- ADR-001 (isolated budget/credential; named metering writes)
- ADR-002 (the per-call auth re-check that this control plane treats as fail-close)
- ADR-004 (what a metered/audited stop may record)
- ADR-006 (where the budget and limits are configured; deployment-local)
- [Threat model](../threat-model.md) — "Denial of service" and "Elevation".
