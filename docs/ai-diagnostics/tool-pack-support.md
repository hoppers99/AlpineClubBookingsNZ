# AI Diagnostics support tool pack (AID-6A)

The first tool pack on the [SELECT-only substrate](tools.md): deployment,
configuration and readiness evidence, plus bounded, sanitized audit correlation.
Delivered under issue #2375 of epic #2369.

Read [tools.md](tools.md) first. This page covers only what this pack adds — its
permissions, its evidence sources, its projections, its bounds, and the one table
grant it argues for.

## What an administrator can ask it

| Question | Tool | Needs |
| --- | --- | --- |
| Why is AI Diagnostics unavailable, degraded, or refusing to run tools? | `diagnostics.readiness` | `support:view` |
| Which release is running, and why can it not explain code? | `diagnostics.deployment_evidence` | `support:view` |
| What is Diagnostics costing this month, and why was a request refused on budget? | `diagnostics.usage_health` | `support:view` |
| Is a scheduled job late or failing? | `diagnostics.background_job_health` | `support:view` |
| What did the platform record around this incident? | `diagnostics.system_event_correlation` | `support:view` |
| …around this booking problem? | `diagnostics.booking_event_correlation` | `support:view` **and** `bookings:view` |
| …around this membership problem? | `diagnostics.membership_event_correlation` | `support:view` **and** `membership:view` |
| …around this payment or Xero problem? | `diagnostics.finance_event_correlation` | `support:view` **and** `finance:view` |
| …around this rosters/chores/work-party problem? | `diagnostics.lodge_event_correlation` | `support:view` **and** `lodge:view` |

Everything here is **read-only**. Nothing in this pack can create, modify, approve,
refuse, refund, reconcile or configure anything, and no tool calls Stripe, Xero, a
bank or an email provider.

## Permissions, and why they are shaped this way

`support:view` is the area that already governs Admin > Support & System — setup,
modules, health, deliverability, audit, issue reports and operational diagnostics —
and `/admin/ai-diagnostics` itself. It is required for **general system evidence
only**.

It is deliberately **not** required for ordinary domain diagnostics. A Booking
Officer investigating a booking does not need a support permission to do their own
job, so the booking tools in AID-6B (#2376) will require `bookings:view` and not
`support:view`. The same holds for membership (#2376) and finance (#2377).

Correlation is the case that needs both, because it reads the platform's audit
trail — a support/system surface — filtered to one business domain. So each
correlation entry declares `support:view` **and** that domain's own area, AND-ed and
re-read from the database on every invocation.

There is deliberately **no `domain` argument**. The substrate authorizes before it
parses arguments (see [tools.md](tools.md) → "The gates, in order"), so an argument
cannot decide an authorization rule. Five fixed entries with five fixed permission
sets is the shape that keeps the two in step.

### What a missing permission looks like

A caller who lacks an area is not offered that tool, and an invocation naming it
anyway is denied server-side with `permission_denied` and the missing area named.
Nothing infers the answer from elsewhere: the category filters are **disjoint**, so
the tool a caller *can* run cannot see the rows the denied one would have returned.
A support-only administrator asking a finance question gets a denial that says
`finance:view` is required — not a system-correlation answer dressed up as a finance
one. A contract test pins the disjointness.

## Evidence sources

Four of the nine entries read a **first-party calculation** rather than the
SELECT-only database, and each has a specific reason:

- **Readiness** combines the module flag, the encrypted dedicated-credential state,
  and the server-verified privilege shape of the diagnostics role. Two of those are
  structurally out of the diagnostics role's reach — ADR-007 forbids granting it any
  access to credential storage — and the third is a verdict *about* that role's own
  connection, which has to stay reportable in exactly the case where that connection
  is the blocker. So the tool reads `getDiagnosticsReadiness`, the same function
  `GET /api/admin/ai-diagnostics/readiness` renders. There is no second readiness
  calculation that can drift from the admin screen.
- **Deployment identity** lives in the image and on disk, not in the database.
- **Budget and usage health** takes its money from `getDiagnosticsUsageSummary`, the
  admin panel's own numbers including the live reservation total the budget gate
  sums. Re-deriving spend in SQL would be a third definition of the money.
- **Background-job health** uses `buildCronHealthReport`, the authoritative
  overdue/failed/skipped classification, over the same rows the Admin > Health screen
  reads. The model is never handed raw timestamps and asked to infer whether a
  nightly job is late.

A server-owned entry is **not** a way around the gates. Registry lookup, loop
budget, fresh AND-ed authorization, `.strict()` argument parsing with the
reserved-key scan, the metering circuit breaker, the fixed projection with redaction
and per-field caps, the row and byte ceilings, truncation honesty and the
approved-metadata audit row all apply identically. The only gate it skips is the
SELECT-only credential check, which does not govern it.

One honest difference is reported rather than hidden: the Admin > Health screen asks
the cron-leader container whether scheduling is enabled, over HTTP. A diagnostics
tool must not make an outbound call, so `cronSchedulingEnabled` reflects **this
container's** configuration. It is its own field, so it cannot silently change a
job's verdict.

## The table grant

This pack adds **one** relation to the `SELECT_GRANTS` allowlist in
`provision-role.ts`, and it grants **columns, not the table**:

```
GRANT SELECT ("id","action","category","severity","outcome","entityType",
              "requestId","createdAt") ON public."AuditLog"
```

| Column | Why the correlation tools need it |
| --- | --- |
| `id` | The evidence reference, and the tiebreaker that makes the ordering total — so the audit `resultHash` is stable for identical evidence. |
| `action` | The stable server-defined action code. |
| `category` | The domain filter, and the field that keeps the five entries disjoint. |
| `severity`, `outcome` | Closed server-side classifications. |
| `entityType` | **What kind** of record the event concerned — never which one. |
| `requestId` | The correlation key that ties one operator action to the events it produced. |
| `createdAt` | The window predicate, and the projected instant. |

`AuditLog` is exactly the relation #2375 says must not be granted wholesale: it also
carries `ipAddress`, `userAgent`, `summary`, `details`, arbitrary `metadata` JSON,
and `memberId` / `actorMemberId` / `subjectMemberId` / `targetId` / `entityId`. A
column grant makes the projection a **server-enforced** boundary rather than an
application one — as the diagnostics role, `SELECT "ipAddress" FROM "AuditLog"` is
refused by PostgreSQL itself (42501), and so is `SELECT *`. A future tool, a
projection bug, or a `psql` session opened with that credential all hit the same
refusal.

`entityId` is the deliberate omission to explain. It is often a member id, and this
pack's permission set is system-plus-domain rather than a per-record investigation
with ADR-004's per-invocation personal-data opt-in. Per-record evidence — the member,
the booking, the payment — is AID-6B (#2376) and AID-6C (#2377) work, under their own
area permission and their own privacy review. Every entry in this pack therefore
reports `surfacesPersonalData: false`, and means it.

The runtime self-check verifies the granted **columns** against the same allowlist
and refuses the role if a wider grant appears. That matters because a hand-added
table-level `GRANT SELECT ON "AuditLog"` leaves the relation-level count at zero —
the relation *is* declared — while the role gains every withheld column. Measured on
PostgreSQL 16: with the eight-column grant, `has_table_privilege` is false and
`has_any_column_privilege` is true, so a relation-level check cannot separate the two
grants even in principle.

Re-running provisioning **narrows** as well as widens: PostgreSQL's `REVOKE`
reference states that revoking a privilege on a table also revokes the corresponding
column privileges, so a release that drops a column from the allowlist really does
take it away. The real-PostgreSQL proof asserts it by hand-granting `"ipAddress"`,
re-provisioning, and finding it refused.

**Upgrading to this release is a two-step operation: deploy, then re-run
`npm run diagnostics:provision-role`.** Until it is re-run, readiness reports
`over_privileged` or the correlation tools fail with a privilege error — the
deliberate friction ADR-007 asks for.

## Bounds

| Control | Value |
| --- | --- |
| Correlation window | Closed enum: `15m`, `1h` (default), `6h`, `24h`, `7d`. No other value parses. |
| Correlation input | One optional **exact** request id, 3–128 characters, no whitespace or quotes. The predicate is `=`; there is no `LIKE`, no wildcard, nothing to enumerate with. |
| Correlation rows | 30, newest first, with truncation reported. |
| Job health rows | 20, **worst severity first**, with the registered job count on every row. |
| Single-row tools | Readiness, deployment and usage health return exactly one row. |
| Server-owned read | 15 s deadline; expiry and refusal are both `evidence_unavailable` with no rows. |

Two of those deserve their reasoning:

- **30 correlation rows, not the 50 #2375 permits.** The substrate renders a tool
  result into an evidence block capped at 8 000 characters. Fifty rows of this shape
  do not fit, so the block would clip its own tail and the model would see a generic
  truncation notice instead of the substrate's honest `truncated` flag over a
  complete prefix.
- **The job-health ceiling is below the number of registered jobs** (34 at the time
  of writing, and the number only grows). Twenty rows render inside that block and the
  whole registry does not, so the source orders by severity (error, warning, info, ok)
  and then by job name, and the executor keeps the first twenty. A healthy job can
  never displace an unhealthy one, and every row carries `registeredJobCount` so
  "twenty of thirty-four" is never mistaken for "twenty jobs exist".

The window predicate is always applied, **including** when a request id is supplied.
That is a performance control: `AuditLog` has no index on `requestId`, so a
request-id-only read would be a sequential scan of the platform's whole access trail
against a 5-second statement timeout. Widen the window if the event being correlated
is older than an hour.

## What is never returned

No API key, encrypted or decrypted credential value, database password, connection
string, role password, credential identifier, or raw privilege detail the readiness
contract withholds. No prompt, answer, tool argument, tool result or provider
payload. No provider error **text** — `usage_health` returns the stable
`latestFailureCode` and not the stored `errorMessage`. No job error text or job result
payload. No stack trace. No IP address, user agent, event description, stored
metadata, member id, booking id or payment id.

The projections are the enforcement: a field a registry entry does not name cannot
reach the model even if its source starts returning it, and the tests hand each
projection a row carrying exactly those secrets and identifiers to prove it.

## Stable states, and freshness

Every result carries an `observedAt` instant and a **stable evidence state** from the
shared vocabulary in `src/lib/diagnostics/case/states.ts`, rendered in the evidence
block as `evidence-state="…"`. The state is what keeps four different things apart
that an empty result cannot:

`not_found` (we looked and there is nothing) · `permission_denied` (you were not
permitted, and nothing inferred it) · `not_configured` (this deployment has not set
it up) · `evidence_unavailable` (the source could not be reached).

Timestamps are ISO-8601 **UTC**, and the field names say so (`occurredAtUtc`,
`latestRunAtUtc`). An operator-facing answer is expected to be rendered in New
Zealand time by the surface that shows it.

## The shared diagnostic-case contract

`src/lib/diagnostics/case/` holds the structure the later packs contribute to, so one
Diagnostics conversation can combine booking, membership and finance evidence for a
single question under whichever areas the administrator holds. It carries the primary
record, the authoritative current state, blockers, warnings, current facts, history
kept apart from current facts, related records, the sources consulted **with their
evidence state**, and suggested next actions with the actor and permission each
needs.

Two properties are load-bearing and both are pinned by tests:

- **A denial is recorded as an outcome, not as a missing source.** A case that simply
  contained no finance evidence would read as "there is no finance problem"; a
  recorded denial says the evidence was withheld and which permission unlocks it.
- **An inference is not a rule result.** Every finding carries a `confidence`, and a
  case whose blockers are all `inferred` reports `hasInferredBlockerOnly`, so a
  surface can frame the answer as a likely cause rather than a verdict.

## Prompt injection

Every projected value comes out of a database and is treated as untrusted,
prompt-injection-capable evidence regardless of how server-owned it looks: it is
redacted and length-capped by the projection step, then neutralised by the evidence
renderer, which strips angle brackets and quotes so a stored value cannot forge a
block delimiter, add an attribute, or fake a new row. The evidence block tells the
model in its own header that everything inside is data to report and never an
instruction to obey.

## Operator troubleshooting

| Symptom | Likely cause | What to do |
| --- | --- | --- |
| Every correlation tool fails; readiness says `over_privileged` | The release added a grant and provisioning has not been re-run | `npm run diagnostics:provision-role`, then re-check readiness |
| Readiness says `not_configured` for the database role | `AI_DIAGNOSTICS_DATABASE_URL` is unset | Provision the role and set the variable ([deployment.md](deployment.md)) |
| `diagnostics.readiness` answers, but no other tool will run | The diagnostics credential is the blocker | Read the `databaseRoleState` and `blockerCodes` this tool returns; that is what it is for |
| A correlation tool returns nothing for a request id you can see in the admin audit log | The event is older than the window | Re-ask with a wider window, up to `7d` |
| `evidence_unavailable` from a system tool | The application's own database or the deployed bundle could not be read | Check application health; this is not the diagnostics credential |
| `knowledgeBundleState` is not `verified` | The deployed knowledge bundle is missing or failed verification | See [the bundle guide](../diagnostics/KNOWLEDGE_BUNDLE.md); code answers stay unavailable until it verifies |
| Background-job health disagrees with Admin > Health about whether cron is enabled | This container's configuration differs from the cron leader's | Trust the screen for scheduling; the per-job classification is identical |

Incident response: the audit trail for tool use is
`ai_diagnostics.tool_invocation` in `AuditLog`, retention class
`sensitive_access` (24 months). It records the acting administrator, the tool id, the
areas checked, the allow/deny outcome, the stable failure reason, a non-reversible
hash of the accepted arguments and of the result, row and byte counts, duration,
round index and the observed-at instant — and never the arguments, the results, the
question or the answer. There is no per-tool version field: a tool's contract is its
code, so the release identifier — which `diagnostics.deployment_evidence` reports —
is what ties an audit row to the exact definition that produced it. To answer "what did this administrator look at",
query that action for their member id; to answer "was this the same answer twice",
compare `resultHash`.

## Adding to this pack

Follow the checklist in [tools.md](tools.md) → "Adding a tool". Two extra rules apply
here:

1. If the question has an authoritative first-party answer already — a rule engine, a
   health classifier, a money calculation — read it as a `server_owned` entry rather
   than re-deriving it in SQL. A second calculation that can drift from the admin
   screen is the failure mode #2375 names explicitly.
2. A new relation is granted **by column** unless every column of it is appropriate
   diagnostics evidence, and the pack doc lists each column with the reason a tool
   needs it. Re-provisioning is part of shipping it.

## Related

- [Tool substrate reference](tools.md) — the gates, bounds, audit, and the rules for
  adding a tool.
- [Deployment and operator guide](deployment.md) — provisioning the role, the grants
  it makes, and what readiness reports.
- [Page context](page-context.md) and the
  [knowledge bundle](../diagnostics/KNOWLEDGE_BUNDLE.md) — the other two evidence
  channels.
- [Hub, ADRs, and threat model](README.md).
