# ADR-001: AI Diagnostics is a Separate, Admin-Only, Read-Only Product

## Status

Proposed — foundation decision for epic #2369 (AI Diagnostics), pending owner
approval on issue #2370. To be marked Accepted when this ADR's pull request
merges.

**Governance:** no implementation child (#2371–#2379) may weaken the contract in
this ADR without an owner decision recorded on-repo (a comment or a superseding
ADR on the relevant issue). A pull request that would relax a boundary here is
not "auto-merge eligible" — it is Critical/High security work and needs owner
review.

## Context

The platform already ships one paid-model surface: the grounded **Page help
assistant** at `POST /api/help/chat` (`src/app/api/help/chat/route.ts`), backed
by `src/lib/anthropic-client.ts`. That assistant is deliberately powerless:

- it is available to any **active member** (`requireActiveSession`), not just
  admins;
- its only source of truth is the trusted, curated, DB-free page-help corpus
  (`buildHelpGrounding`), and the model is told, in a frozen system prompt, that
  it "has no tools, no actions, and no access to any account, booking, or
  database" (`HELP_SYSTEM_PROMPT`, `src/lib/anthropic-client.ts:36-50`);
- client-supplied `pageContext` is an untrusted flat string that never joins the
  grounding and travels only in the final user turn, wrapped and angle-bracket
  stripped.

AI Diagnostics is a fundamentally different product. It is an **admin-only**
assistant that can *retrieve bounded, typed, permission-scoped operational
evidence* — deployed source/docs/schema, structured page context, and the
results of SELECT-only database tools — to help an operator understand why the
deployed system behaves as it does. That capability is exactly what the Page
help assistant is forbidden to have.

The risk is that, because a paid-model client, a credential store, a metering
ledger, and a rate-limit harness already exist for Page help, a future
implementer "reuses" them and silently inherits Page help's *policy* surface:
member-level admission, a shared budget, a shared credential, and the assumption
that the model has no tools. That would collapse the two products' threat models
into one and defeat the isolation this epic exists to create.

## Decision

### 1. Diagnostics is its own product, not an expansion of Page help

Diagnostics ships its own capability/module flag, its own admission rule
(ADR-002), its own budget and rate limits (ADR-005), its own credential posture
(below), its own deployed-knowledge artifact (#2372), its own typed structured
page context (#2373), and its own SELECT-only database substrate and credential
(#2374, ADR-007).

Diagnostics **must not** reuse `/api/help/chat`, `buildHelpGrounding`, the Page
help corpus, or the Page help module flag as its policy, credential, or budget
surface. Sharing low-level, policy-free plumbing (for example the SDK error
taxonomy in `anthropic-client.ts`, or the `rate-limit.ts` primitives) is
permitted only where it carries no admission, budget, or trust assumption; the
moment a shared helper encodes "member-level access is fine" or "one budget for
both", it must be forked.

Page help remains member/admin help. Diagnostics is admin-only.

### 2. "Read-only" is defined precisely

Diagnostics is **read-only with respect to the club's domain**. It has:

- **No domain-mutation tools.** It can never create, update, delete, cancel,
  refund, approve, invoice, allocate, email, or otherwise change a booking,
  member, payment, subscription, family, induction, allocation, notice, Xero
  object, or any other domain record.
- **No model-generated SQL.** The model never authors or influences a SQL
  string. Tools expose fixed, typed, parameterised queries only (ADR-007).
- **No DOM scraping and no screenshots.** Diagnostics never reads the live
  browser DOM or captures images of any screen; page context is the typed,
  server-declared structured context of #2373, not scraped markup.
- **No raw credentials.** No API key, token, password, 2FA secret, session, or
  connection string is ever exposed to the model, returned to the client, logged,
  or audited (this extends the existing Anthropic-key exposure contract in
  `src/lib/ai-assistant-config.ts:11-15`).
- **No unrestricted PII and no raw provider payloads.** Personal data is
  bounded, redacted, and opt-in (ADR-004); raw Stripe/Xero/SES/Sentry payloads
  are never surfaced — only sanitized, typed correlations (ADR-003).

### 3. The only writes Diagnostics performs are isolated metering/audit metadata

"Read-only" permits a small, **named** set of first-party bookkeeping writes,
and nothing else:

- **Usage/metering rows** — the Diagnostics equivalent of
  `AiAssistantUsageEvent` / `AiAssistantUsageMonthly`
  (`src/lib/ai-assistant-usage.ts`): per-call token counts, estimated
  integer-cent cost, model id, success/failure, duration. Never the prompt,
  the answer, tool arguments, or tool results.
- **Audit rows** — one structured audit record per tool invocation carrying the
  approved metadata set of ADR-004 (tool id, auth outcome, row/count/byte/timing
  /hash), never raw args/results/prompts/answers.
- **Rate-limit counters** — the shared `RateLimitCounter` store
  (`src/lib/rate-limit.ts`).

Any write outside this list is a domain mutation and is forbidden.

### 4. Credential posture: isolated from Page help

Diagnostics authorises paid model spend, so its credential is the
highest-privilege secret in its lane and is treated exactly like the Page help
Anthropic key and the Stripe secret key: stored only in the encrypted
`IntegrationCredential` store, never returned to a client, logged, or audited
(`src/lib/ai-assistant-config.ts`).

The credential and budget surface are **isolated** from Page help so that a
Diagnostics incident (a leaked key, a runaway spend, a forced disable) cannot
take down member-facing Page help, and vice versa.

> **Open owner decision (recommended default).** Whether isolation means a
> *physically distinct Anthropic API key* (a separate `IntegrationCredential`
> slot, so the two products can be keyed, rotated, and revoked independently) or
> the *same key with a separate budget/metering ledger*. **Recommended: a
> distinct credential slot.** It is the only option that lets an operator revoke
> Diagnostics without disabling Page help, contains a Diagnostics key
> compromise, and keeps the two spend caps genuinely independent; the cost is one
> extra key to enter and rotate. Recorded for the owner on #2370; AID-2 (#2371)
> implements whichever is chosen.

## Consequences

### Positive

- The two products have independent threat models; Diagnostics cannot silently
  inherit member-level admission or a shared budget.
- The read-only definition is explicit enough that a reviewer can reject any
  child PR that introduces a mutation path, model SQL, DOM scraping, a screenshot,
  a raw credential, unrestricted PII, or a raw provider payload.
- The named write list makes "read-only" auditable rather than aspirational.

### Negative

- Diagnostics carries its own module flag, credential, budget, metering, and
  rate limits rather than reusing Page help's — more surface to build and
  operate (the point of the epic).
- Operators must understand two AI surfaces with two spend caps, documented in
  the operator plan (see the hub) and the AI help guide.

## Related

- ADR-002 (admission and per-tool authorization lattice)
- ADR-003 (untrusted evidence classes)
- ADR-004 (sensitive-record context, retention, redaction, audit metadata)
- ADR-005 (budget, rate limits, tool-loop bounds, fail-closed control plane)
- ADR-006 (deployment, provider disclosure, private overlay, config non-travel)
- ADR-007 (least-privilege SELECT-only database credential)
- ADR-008 (answer output channel: inert render, strict CSP, untrusted output)
- [Threat model](../threat-model.md)
