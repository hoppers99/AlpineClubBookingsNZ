# AI Diagnostics — security verification matrix

> Part of the [AI Diagnostics hub](README.md) and the
> [documentation hub](../README.md).

The adversarial verification coverage AID-8 (#2379) established for the shipped AI
Diagnostics product, and — just as importantly — the honest limits of it. Each
security property below names the tests that prove it and the **tier** of that proof,
because the tiers do not prove the same thing:

- **mocked-provider unit** — Vitest, no real model and usually no real database. It
  proves the *code's* logic: gate ordering, refusal wording, that a value is dropped
  rather than truncated. It cannot prove anything about PostgreSQL's own behaviour or
  a real model's response.
- **real-Postgres** — a `*.realdb.test.ts` suite run in CI's **Migration drift
  check** job (opt-in `RUN_CONCURRENCY_RACE_TESTS=1`, dedicated loopback database).
  It proves claims about the database server itself — that a `REVOKE` really took,
  that a role really cannot write.
- **Playwright E2E** — `e2e/ai-diagnostics.spec.ts`, driving the **real** route and
  the real registry against seeded data. It deliberately **never reaches the paid
  provider**: a demo deployment has no diagnostics credential, so a real question is
  refused by a real gate, which is exactly the "told something true and actionable,
  not 'AI failed'" property #2378 asked to be proved.
- **live browser + model — still needed** — properties that only a real model and a
  real browser can close, listed as such rather than claimed.

This extends the repository-wide [`END_TO_END_TEST_MATRIX.md`](../END_TO_END_TEST_MATRIX.md).

## The matrix

| # | Security property | Proven by | Tier |
| --- | --- | --- | --- |
| 1 | **Admission grants nothing; every tool re-checks its own area fresh.** `overview:view` admits the shell; the offer matrix is re-read from the database, and `invoke.ts` re-derives authority on every invocation. Withholding a tool is courtesy, not the control. | `src/app/api/admin/ai-diagnostics/ask/__tests__/route.test.ts`, `src/lib/diagnostics/tools/__tests__/invoke.test.ts`, `src/lib/diagnostics/tools/__tests__/authorize.test.ts` | mocked-provider unit |
| 2 | **Fresh revocation is honoured mid-conversation.** A member deactivated, put under a forced password change, or stripped of an area between turns is refused; a read failure is a typed failure, never an empty "no areas" matrix. | `src/lib/diagnostics/page-context/__tests__/authorize.test.ts`, `src/app/api/admin/ai-diagnostics/ask/__tests__/route.test.ts` | mocked-provider unit |
| 3 | **Per-tool authorization lattice (AND across cross-area tools).** Single-area tools stay under their own area; cross-domain entries require **all** their named areas; authorization runs **before** argument parsing so it cannot be used as an oracle. | `src/lib/diagnostics/tools/__tests__/authorize.test.ts`, `src/lib/diagnostics/tools/packs/__tests__/booking-membership-pack.test.ts`, `src/lib/diagnostics/tools/packs/__tests__/finance-pack.test.ts` | mocked-provider unit |
| 4 | **Consent is per-request and fail-closed.** The ledger is seeded only from the record the server resolved and the two per-question ticks; a per-record read with no record refuses (`record_not_included`), a people search with no tick refuses; both ticks reset after every send. | `src/lib/diagnostics/tools/__tests__/consent.test.ts`, `src/lib/diagnostics/tools/__tests__/invoke-consent.test.ts`, `src/components/help-widget/__tests__/diagnostics-view.test.tsx` | mocked-provider unit |
| 5 | **Prompt injection is inert across every untrusted channel** — deployed-source evidence, page context, tool result, replayed conversation, and the question. Each is folded and defused; forged turn labels do not become turn boundaries; the transcript is replayed as one wrapped **user** turn, never as `assistant` authority. | `src/lib/diagnostics/__tests__/untrusted-text.test.ts`, `src/lib/diagnostics/__tests__/untrusted-wrapper-census.test.ts`, `src/lib/diagnostics/answer/__tests__/prompt.test.ts`, `src/lib/diagnostics/page-context/__tests__/render.test.ts`, `src/lib/diagnostics/tools/__tests__/render.test.ts`, `src/lib/diagnostics/tools/packs/__tests__/untrusted-text-projection.test.ts`, `src/lib/diagnostics/tools/packs/__tests__/untrusted-text-projection-census.test.ts` | mocked-provider unit (see gap A) |
| 6 | **The route refuses malformed control characters** in the question and any replayed turn, so a two-hop stored-injection path cannot smuggle a line terminator past the fold. | `src/app/api/admin/ai-diagnostics/ask/__tests__/route.test.ts` | mocked-provider unit |
| 7 | **Reads are SELECT-only, proven against PostgreSQL.** The shipped provisioning statements are run, then the restricted role is proven unable to `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`, do nine forms of DDL, read `IntegrationCredential` or any un-granted table/column, or self-grant; a granted `INSERT` is still refused by the read-only transaction; a real superuser credential is refused by the runtime self-check; a long query is cancelled at the statement timeout. | `src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts` | real-Postgres |
| 8 | **The allowlist is exactly the columns a shipped statement reads** — proven in both directions against the server (a column is readable **iff** a registered statement reads it), and re-provisioning genuinely **narrows** (a hand-granted extra column becomes refused after a re-run). | `src/lib/__tests__/ai-diagnostics-select-only-role.realdb.test.ts`, `src/lib/diagnostics/tools/__tests__/provision-role.test.ts` | real-Postgres + mocked-provider unit |
| 9 | **The server_owned seam is read-only.** The three authoritative calculations run the platform's own evaluators in-process inside one `REPEATABLE READ` read-only transaction, with every collaborator bound to it; no write escapes. | `src/lib/__tests__/ai-diagnostics-readonly-seam.realdb.test.ts`, `src/lib/diagnostics/tools/packs/__tests__/server-owned-collaborator-readonly.realtime.test.ts` | real-Postgres |
| 10 | **No mutation surface.** The read-only transaction wrapper, the executor's outermost `LIMIT`, the over-size refusal, and the no-model-SQL registry shape are all pinned; there is no mutation tool and no model-supplied SQL. | `src/lib/diagnostics/tools/__tests__/read-only-transaction.test.ts`, `src/lib/diagnostics/tools/__tests__/invoke-projection.test.ts`, `src/lib/diagnostics/tools/__tests__/registry.test.ts` | mocked-provider unit |
| 11 | **No secret or unrestricted-PII leakage.** The knowledge bundle is secret-scanned; readiness never returns the connection string, password, or role name and keeps credential detail behind `support:view`; provenance carries no record ids, personal fields, tool args, or row contents; only approved audit metadata is retained. | `src/lib/diagnostics/knowledge/__tests__/secret-scan.test.ts`, `src/lib/__tests__/diagnostics-readiness-tiers.test.ts`, `src/lib/diagnostics/answer/__tests__/provenance.test.ts` | mocked-provider unit |
| 12 | **Budget cannot be overspent by a concurrent burst.** `settled + reserved` never exceeds the monthly budget under genuinely concurrent reservers, with the dangerous interleaving **forced** (not hoped for) via a held advisory lock and a `backend_xid IS NULL` barrier. | `src/lib/__tests__/ai-diagnostics-budget-race.realdb.test.ts`, `src/lib/__tests__/ai-diagnostics-usage.test.ts` | real-Postgres + mocked-provider unit |
| 13 | **Budget/rate/recovery fail closed and settle honestly.** Reserve fails closed on any fault; the metering circuit breaker blocks before spending; the loop is bounded to 8 rounds; every roundtrip settles on success **and** failure; each refusal reason maps to its own operator sentence and never says "reload". | `src/lib/diagnostics/answer/__tests__/loop.test.ts`, `src/lib/__tests__/ai-diagnostics-usage.test.ts`, `src/components/help-widget/__tests__/diagnostics-view.test.tsx` | mocked-provider unit |
| 14 | **The deployment artifact refuses safely end to end.** Against the real route and seeded data with no provider credential, the module switch controls the tab and the endpoint together, a seeded booking row becomes the subject, the ticks start unticked and reset, and the refusal is the server's own copy — never "AI failed", never "reload". | `e2e/ai-diagnostics.spec.ts` | Playwright E2E |
| 15 | **The answer render is inert under a strict CSP** (ADR-008): no auto-loaded images, arbitrary hyperlinks, or `data:` URIs, and an `img-src`/`connect-src` CSP blocks egress. | route/render unit coverage above | mocked-provider unit (see gap B) |

## Gaps: what still needs a live browser + model pass

These are stated plainly rather than folded into a green cell. None is a code
deficiency; each is a property that only a real model or a real browser can close,
and none is exercised by the E2E suite because it deliberately never spends money.

- **Gap A — injection inertness against a real model.** The five channels are proven
  *neutralised at the boundary* (property 5) — the model receives folded, wrapped,
  label-defused text. Whether a live model, given that neutralised text, ever treats
  it as instruction is not asserted by any automated test here. A manual adversarial
  pass against the real provider is the closing step, run out of band because it
  spends budget.
- **Gap B — CSP egress in a real browser.** ADR-008's inert render and the
  `img-src`/`connect-src` CSP are asserted at the markup/route level. That the CSP
  actually blocks a beacon *in a browser* — an injected image or `fetch` failing to
  leave the admin's tab — needs a live browser check against a deployed instance.
- **Gap C — a real end-to-end answer.** Every E2E path stops at a gate refusal by
  design (no credential in the demo stack). A configured staging deployment with a
  dedicated key is where a real question, a real tool round, and a real cited answer
  are exercised; that is a staging/owner step, not a CI gate.

## Related links

- Back to the [AI Diagnostics hub](README.md) and the
  [documentation hub](../README.md).
- [Architecture](architecture.md) — the path each property sits on.
- [Deployment and operator guide](deployment.md) — how to run the real-Postgres
  privilege proof yourself.
- [Threat model](threat-model.md) — the trust boundaries these properties defend.
- The repository-wide [`END_TO_END_TEST_MATRIX.md`](../END_TO_END_TEST_MATRIX.md).
