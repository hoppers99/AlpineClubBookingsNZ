# AI Diagnostics

> Part of the [documentation hub](../README.md).

AI Diagnostics is a **separate, admin-only** assistant that helps an operator
understand why the *deployed* system behaves as it does. It can retrieve bounded,
typed, permission-scoped **read-only** evidence — deployed source/docs/schema,
typed structured page context, and the results of SELECT-only database tools — and
explain it with citations.

It is **not** an expansion of the member-facing Page help assistant
(`/api/help/chat`). Page help is powerless by design (no tools, no data, member
-level access); Diagnostics has tools and data and is therefore admin-only,
read-only, budgeted, and audited. Keeping the two products' security models
separate is the reason this subsystem exists — see
[ADR-001](decisions/ADR-001-separate-admin-only-diagnostics-product.md).

**Status:** design/foundation. This hub, the ADRs, and the
[threat model](threat-model.md) are the security/privacy/authority/evidence
contracts, written under issue #2370 (AID-1) **before** the nine implementation
children of epic #2369 are built. The subsystem is **off by default** and
deployment-local.

## Governance: these contracts are binding

The ADRs in [`decisions/`](decisions/) and the [threat model](threat-model.md)
set the contracts every implementation child (#2371–#2379) is built against.

> **No implementation child may weaken any contract in this hub without an owner
> decision recorded on-repo** (a comment or a superseding ADR on the relevant
> issue). A pull request that would relax an admission rule, a prohibition, an
> evidence boundary, a retention/redaction rule, a budget/limit, or the database
> least-privilege contract is Critical/High security work — it is never
> auto-merge eligible and requires owner review.

## Frozen product boundaries (at a glance)

- **Admission is any-admin; every tool re-checks its own `area:view` fresh on
  every call.** Opening the shell reveals nothing (ADR-002).
- **Read-only means no domain mutation.** No mutation tools, no model-generated
  SQL, no DOM scraping, no screenshots, no raw credentials, no unrestricted PII,
  no raw provider payloads. The only writes are isolated metering/audit/rate-limit
  metadata (ADR-001).
- **All evidence is untrusted, prompt-injection-capable data** — it never carries
  system authority and never authorizes a tool (ADR-003).
- **Sensitive record context is opt-in; only approved metadata is retained**
  (tool id, auth outcome, row/count/byte/timing/hash) — never prompts, answers,
  args, results, payloads, credentials, or unrestricted identifiers (ADR-004).
- **A dedicated fail-closed control plane:** own monthly integer-cent budget,
  per-round-trip reserve, bounded tool loop, per-IP/per-admin/global rate limits
  (ADR-005).
- **Deployment-local and fork-safe:** provider/data-residency disclosure, optional
  zero-retention, a generic deployment-owned private overlay (never Tokoroa
  paths), config that does not travel between deployments (ADR-006).
- **A dedicated non-superuser SELECT-only database credential** — never the app's
  superuser `DATABASE_URL` (ADR-007).

## Permission matrix (summary)

Each tool declares the admin area that already governs its data in the admin UI,
re-checked at `view` on every call. Authoritative version and semantics (any-admin
admission, AND across cross-area tools, fail-closed) in
[ADR-002](decisions/ADR-002-admission-and-per-tool-authorization-lattice.md).

| Tool pack / child | Required (fresh) permission |
| --- | --- |
| Config/readiness + sanitized correlation (AID-6A, #2375) | `support:view` |
| Booking & bed-allocation tools (AID-6B, #2376) | `bookings:view` |
| Membership & induction tools (AID-6B, #2376) | `membership:view` |
| Finance & Xero-linkage tools (AID-6C, #2377) | `finance:view` |

## Architecture decision records

- [ADR-001: Separate, admin-only, read-only product](decisions/ADR-001-separate-admin-only-diagnostics-product.md)
- [ADR-002: Admission and per-tool authorization lattice](decisions/ADR-002-admission-and-per-tool-authorization-lattice.md)
- [ADR-003: All evidence is untrusted, prompt-injection-capable](decisions/ADR-003-untrusted-evidence-classes.md)
- [ADR-004: Sensitive context, retention, redaction, audit metadata](decisions/ADR-004-sensitive-context-retention-redaction-audit-metadata.md)
- [ADR-005: Budget, rate limits, tool-loop bounds, fail-closed control plane](decisions/ADR-005-budget-rate-limits-tool-loop-fail-closed.md)
- [ADR-006: Deployment, provider disclosure, private overlay, config non-travel](decisions/ADR-006-deployment-provider-disclosure-private-overlay-config-non-travel.md)
- [ADR-007: Dedicated least-privilege SELECT-only database credential](decisions/ADR-007-least-privilege-select-only-database-credential.md)

## Threat model

The [STRIDE-style threat model](threat-model.md) enumerates the trust boundaries,
data flows, abuse cases, per-boundary threats and mitigations, and the fail-closed
control matrix. Each mitigation is fixed by one of the ADRs above.

## Documentation plan

The subsystem's documentation is delivered with its implementation children. This
hub is the index; each child adds or extends the documents below and links them
here as it lands, so this hub stays the single reachable entry point. Planned
subsystem documents (not yet written) are named in `code font` with their owning
child; the existing repository-wide documents they extend are linked.

| Area | Planned subsystem doc (owner) | Existing docs it extends |
| --- | --- | --- |
| **Architecture** | `docs/ai-diagnostics/architecture.md` — runtime shape, the tool substrate, the deployed-knowledge bundle, and data flows (AID-2 #2371 / AID-5 #2374) | [`ARCHITECTURE.md`](../ARCHITECTURE.md), [`DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) |
| **Security / privacy** | This hub's [threat model](threat-model.md) and [ADRs](decisions/) (AID-1, this issue); release hardening notes (AID-8 #2379) | [`SECURITY.md`](../SECURITY.md), [`SECURITY-ATTACK-SURFACE.md`](../SECURITY-ATTACK-SURFACE.md), [`agents/PROMPT_INJECTION_GUIDE.md`](../agents/PROMPT_INJECTION_GUIDE.md) |
| **Deployment / operator** | `docs/ai-diagnostics/deployment.md` — enabling the module, the SELECT-only DB role, the credential, budget/limits, disclosure and zero-retention, the private overlay (AID-2 #2371 / AID-5 #2374 / AID-8 #2379) | [`../../DEPLOYMENT.md`](../../DEPLOYMENT.md), [`ONGOING_DEVELOPMENT_WORKFLOW.md`](../ONGOING_DEVELOPMENT_WORKFLOW.md) |
| **UX** | `docs/ai-diagnostics/ux.md` — the Diagnostics shell, evidence citations, permission-scoped answers, fallbacks (AID-7 #2378) | [`UX_FLOW_MAP.md`](../UX_FLOW_MAP.md) |
| **E2E test matrix** | `docs/ai-diagnostics/e2e-matrix.md` — admission, per-tool auth, injection inertness, budget/limit fail-closed, redaction (AID-8 #2379) | [`END_TO_END_TEST_MATRIX.md`](../END_TO_END_TEST_MATRIX.md) |
| **Operator help** | Operator guidance for the Diagnostics surface (AID-7 #2378 / AID-8 #2379) | [`guides/ai-help.md`](../guides/ai-help.md) |

## Maintenance rules

- Do not point Diagnostics tools at the application's `DATABASE_URL`; update
  ADR-007 first if the least-privilege database contract changes.
- Do not add a tool that mutates, generates SQL, scrapes the DOM, or returns raw
  credentials/PII/provider payloads; ADR-001 forbids it.
- Do not widen admission or drop a tool's fresh `area:view` re-check; ADR-002 is
  the contract.
- Keep Diagnostics config deployment-local and out of config-transfer bundles
  unless ADR-006 is superseded by an owner decision.
- When a child ships a subsystem document from the plan above, replace its
  `code-font` placeholder with a real link in the same PR.
