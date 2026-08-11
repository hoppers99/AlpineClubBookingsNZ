# ADR-004: Sensitive-Record Context, Retention, Redaction, and Approved Audit Metadata

## Status

Proposed — foundation decision for epic #2369 (AI Diagnostics), pending owner
approval on issue #2370. To be marked Accepted when this ADR's pull request
merges.

**Governance:** no implementation child (#2371–#2379) may weaken the contract in
this ADR without an owner decision recorded on-repo.

## Context

Diagnostics reads operational records that contain personal data: members,
family relationships, bookings, payments, deletion requests. The Page help
precedent is strict — it stores only a question's *character count*, never its
text (`src/lib/ai-assistant-usage.ts:12-14`), and redacts any provider error
before it is persisted (`redactSensitiveText`, lines 252-256). Diagnostics
handles far more personal data than Page help, and its results are, by design,
sent to a third-party model provider (ADR-006). Two things therefore need
explicit contracts: **what personal data is ever surfaced**, and **what is ever
written down about a Diagnostics session**.

## Decision

### 1. Sensitive record context is opt-in per invocation

Diagnostics does not sweep personal data into the model's context by default. A
tool that returns personal fields about an identifiable person (a member's
contact details, a family's membership, a payer's ledger) surfaces them **only
when the operator has explicitly included that specific record** in the request —
an affirmative, per-invocation inclusion, never an ambient "here is everything
about everyone on this page". Absent explicit inclusion, tools return
non-identifying aggregates (counts, states, timings) or an explicit "personal
detail omitted — include the record to see it".

Inclusion never overrides ADR-002: a tool still fails closed unless the caller
holds the governing `area:view`, and unrestricted bulk PII export is not a
capability Diagnostics offers at any permission level.

### 2. Redaction before anything leaves the substrate

- **To the provider:** only bounded, typed excerpts go to Anthropic (ADR-003).
  Secrets are never in scope (ADR-001), and free-text fields pass through the
  shared redaction (`redactSensitiveText` / `redact-sensitive-json`) so that an
  API key, token, or obvious secret pattern embedded in a note is stripped before
  it is sent.
- **To the operator:** the answer is scoped to what the operator was already
  entitled to read in the admin UI (ADR-002); Diagnostics is not a side channel
  around field-level admin redaction.

### 3. Retention: session content is ephemeral; only metadata persists

- The **prompt, the model's answer, tool arguments, and tool results are not
  persisted.** They exist for the lifetime of the request and are discarded.
- The provider-side retention is governed by the deployment's provider posture
  (ADR-006), including the optional zero-retention setting.
- The only durable records are the metering and audit rows of ADR-001 §3, which
  carry the approved metadata set below and nothing else. They follow the
  platform's existing audit-log retention
  ([`AUDIT_RETENTION_ARCHIVE_RUNBOOK.md`](../../AUDIT_RETENTION_ARCHIVE_RUNBOOK.md)).

### 4. The approved audit metadata set (exhaustive)

A Diagnostics audit/metering row may record **only**:

- **tool id** — which capability ran (a registry key, not free text);
- **auth outcome** — allowed / denied, and the area/level checked;
- **row count** — how many rows a query matched;
- **byte count** — the size of the excerpt returned;
- **timing** — started-at, duration;
- **hash** — a stable, non-reversible hash of a query key or record reference
  where correlation across rows is needed without storing the identifier itself;
- the metering fields of ADR-001 §3 (model, token counts, integer-cent cost,
  success/failure).

A row may record **none** of: raw tool arguments, raw tool results, the prompt,
the model's answer, raw provider payloads, credentials, or unrestricted personal
identifiers (a member's name, email, or raw id where a hash suffices). This
mirrors and extends the Page help "never store the question text" rule.

## Implementation note — how §1 is enforced in the tool channel (AID-7a, #2785)

This note records how the decision above was implemented; it does not change it.

**The tool channel takes §1's SECOND branch.** §1 offers two ways to behave absent
explicit inclusion: non-identifying aggregates, **or** an explicit "personal detail
omitted — include the record to see it". Field-level omission would mean a second
projection for every flagged entry, doubling the surface every pack review has
already covered, so the tool channel refuses the invocation instead and returns
exactly that notice as its operator sentence
(`sensitive_consent_required` → evidence state `consent_required`). The case reports
itself incomplete. The page-context channel is unchanged and still omits fields.

**Inclusion is per request, over a bounded investigation.** A single
`{recordKind, recordId}` consent cannot drive a tool graph whose flagship
investigation crosses record kinds by the registry's own authored guidance. So
consent is a server-held ledger (`src/lib/diagnostics/tools/consent.ts`), built for
one request and discarded with it: seeded only from records the operator selected
and the server re-resolved under their own authority, extended only by absorbing the
projected fields an entry **declares** as related-record refs after a successful,
authorised, audited call, and bounded to **one hop** from an operator selection. The
model can never write to it. This is what epic #2369's owner comment authorises —
"for an explicit bounded investigation the agent may receive the personal and
financial information reasonably required… the restriction is against unrestricted
or bulk access".

**Record search is a separate, explicitly granted capability.** The four search
entries return bounded LISTS of people, bookings or payments, which is how a model
would otherwise choose a subject for itself. They are declared `operatorOnly` and run
only as the operator's own record-picker action, or — on the owner's decision of
11 Aug 2026 (#2378 Q2) — as a model tool call on a request where the operator ticked
an explicit people-search box, off by default and never persisted. The gate is a
typed, server-owned invocation channel on the executor's input, not the free-form
`surface` label.

**Five fields are added to §4's approved set**, and they are inside it rather than an
extension of it: §4 permits recording the auth outcome, and consent is the second
half of the authorisation. They are `invocationChannel`, `sensitiveInclusion`,
`consentRecordKind`, `consentRecordOrigin` and `peopleSearchTick` — every one a
closed enum or null. **No subject record id is recorded**: `argsHash` already pins
which record non-reversibly, and adding the identifier would put an unrestricted
personal identifier into a 24-month row, which §4 forbids. Without these fields a
consented read and an unconsented one were the same durable row.

## Consequences

### Positive

- A Diagnostics session leaves an auditable trail (who ran which tool, allowed or
  denied, how much data, how long) without that trail itself becoming a personal
  -data or secret store.
- Personal data reaches the provider only when an operator deliberately included
  a specific record and only within their own read authority.

### Negative

- Post-hoc debugging of "what exactly did the model see" is limited by design —
  the trail is metadata, not transcript. Reproduction relies on re-running with
  the same inputs, not reading a stored answer.
- Every tool result shape must separate "identifying" fields (opt-in) from
  "aggregate" fields (default), adding modelling work per tool.

## Related

- ADR-001 (named write list; no raw credentials/PII/payloads)
- ADR-003 (bounded excerpts; observed-at and citation)
- ADR-006 (provider retention posture; optional zero-retention)
- [Threat model](../threat-model.md) — "Information disclosure" and "Repudiation".
- [`AUDIT_RETENTION_ARCHIVE_RUNBOOK.md`](../../AUDIT_RETENTION_ARCHIVE_RUNBOOK.md)
