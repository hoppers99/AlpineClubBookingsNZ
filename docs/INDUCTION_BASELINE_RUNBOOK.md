# Trusted legacy induction baseline

Audience: Operator

## What this runbook does

Use this one-off maintenance command when the club has trustworthy historical
evidence that its existing members completed a new-member induction before the
digital induction register was introduced. The command records that baseline
without fabricating signers, sign-offs, or hut-leader eligibility.

The command is dry-run-first. A run without `--apply` only reports what it
would do. An apply needs exact club and database confirmations, runs in one
database transaction, and either creates every planned row or creates none.
It does not call Stripe, Xero, SES, Sentry, or another external provider.

This is not a general induction import. Do not use it when the historical
source cannot support one common New Zealand date and one provenance note, or
when individual members need different induction facts.

## Before you start

Arrange a maintenance window and confirm all of the following:

- The committee has approved the historical source, the common induction date,
  and the wording of the provenance note.
- A current, tested database backup is available. Rehearse the procedure on a
  non-production copy before an authorised live run.
- The deployed application and generated Prisma client match the database
  schema.
- The actor member ID belongs to an active, login-enabled, non-archived,
  non-cancelled Full Admin.
- Age-tier settings form a complete, non-overlapping Infant / Child / Youth /
  Adult partition. The command does not use fallback tiers when this config is
  missing or invalid.
- Exactly one active New Member induction template exists, and it contains at
  least one valid section and checklist item.
- Every open Draft or In Progress induction reported by the dry run has been
  resolved through the normal Induction Register workflow.

The population is limited at the database query to active, non-archived,
non-cancelled real-member records whose member role is `USER` or `ADMIN`.
Login is deliberately not required for this population, so non-login
dependants remain included. Lodge-device (`LODGE`), non-member contact
(`NON_MEMBER`), and school contact (`SCHOOL`) rows are excluded. Within the
real-member population, every configured person age tier participates,
including Infant, Child, Youth, and Adult; `N/A` records are reported
separately and are not changed. A member with any completed induction kind is
preserved and classified as `ALREADY_COMPLETED`; the command does not add
another completion.

## 1. Run and retain the dry-run report

Run from the application checkout whose `DATABASE_URL` targets the intended
database:

```bash
npm run induction:baseline -- \
  --actor-member-id <full-admin-member-id> \
  --baseline-date <YYYY-MM-DD> \
  --provenance-note "<legacy register and committee-authorisation reference>"
```

The date is a New Zealand date-only lodge date. The note is stored with the
stable prefix `Trusted legacy induction baseline:` on every new row, so choose
wording that remains meaningful as a permanent audit record.

The report displays only the parsed database host (including an explicit port)
and database name. It never displays the database URL, username, or password.
Do not paste a database URL or credentials into the note, a ticket, or the
retained report.

Review all four deterministic categories and the per-age-tier counts:

| Category | Meaning | Apply behaviour |
| --- | --- | --- |
| `CREATE` | Eligible member has no completed or open induction | Create one completed New Member baseline row |
| `ALREADY_COMPLETED` | Member has at least one completed induction of any kind | Preserve and skip |
| `OPEN_WORKFLOW` | Eligible member has a Draft or In Progress induction | Block the entire apply |
| `NOT_APPLICABLE` | In-scope `USER`/`ADMIN` member has the `N/A` age tier | Report only |

A member with both a completed row and an open row is reported as
`OPEN_WORKFLOW`; the open workflow must be resolved before apply. Voided rows
are preserved but do not make a member completed.

Stop if the club, database host, database name, population, template, date, or
provenance is not exactly what you expected. Resolve the discrepancy and
generate a fresh dry run. Do not edit a saved report and treat it as current.

## 2. Apply with exact confirmations

Use the exact effective club name, parsed host, and database name printed by
the reviewed dry run:

```bash
npm run induction:baseline -- \
  --apply \
  --actor-member-id <full-admin-member-id> \
  --baseline-date <YYYY-MM-DD> \
  --provenance-note "<same legacy register and committee-authorisation reference>" \
  --confirm-club-name "<exact club name from the dry run>" \
  --confirm-db-host "<exact host[:port] from the dry run>" \
  --confirm-db-name "<exact database name from the dry run>"
```

All confirmations are case-sensitive and exact. Apply validates the actor,
configuration, template, and population again. It then locks the
`MemberInduction` table against concurrent insert, update, and delete writers
before re-reading and classifying every row. If an induction writer is already
running, apply waits for it; new induction writes wait until apply commits. A
timeout, lock error, changed club or database target, invalid configuration,
or newly-open workflow fails the whole transaction.

Each created row is:

- kind `NEW_MEMBER`;
- status `COMPLETED`;
- completion source `ADMIN_OVERRIDE`;
- dated with the same supplied value for `inductionDate` and `completedAt`;
- attributed to the supplied Full Admin actor; and
- linked to the active New Member template version.

The command creates no assigned signers, sign-offs, emails, provider jobs, or
hut-leader side effects. Existing induction rows are never updated or deleted.
An audit entry and all baseline rows commit together.

## 3. Verify

1. Retain the successful apply report with the committee authorisation record.
2. Open **Admin → Members → Induction** and spot-check members from every
   configured age tier.
3. Confirm the rows show New Member, Completed, the baseline date, and no
   signers or sign-offs.
4. Re-run the dry-run command with the same actor, date, and note. It should
   report `CREATE: 0`; the applied members should now be
   `ALREADY_COMPLETED`.

Rerunning apply after a successful run is a no-op: no induction rows and no
additional audit entry are created.

## Recovery and rollback

- Before commit, every failure rolls back the full apply. Correct the cause and
  start again with a fresh dry run.
- After commit, do not bulk-delete or edit induction history by hand. If one
  person was included on incorrect evidence, use the normal admin workflow and
  preserve an explanation in the audit trail. If the whole baseline was
  unauthorised or materially wrong, stop membership operations and agree a
  reviewed data-recovery plan with the repository owner; restoring the tested
  pre-run backup may be safer than inventing a reverse script.
- If apply reports `OPEN_WORKFLOW`, resolve those named records in the
  Induction Register rather than changing their database rows directly.
- If config or template validation fails, fix it through the relevant admin
  settings page, then run dry-run again. Never weaken the guard to force an
  apply.
- If a database lock or transaction timeout occurs, confirm no induction
  maintenance is still running and retry from a fresh dry run. PostgreSQL
  rolls the failed transaction back.

## Related links

- Back to the [documentation hub](README.md).
- Operator guide: [Induction](guides/induction.md).
- Reference: [Lodge Induction Lifecycle](STATE_MACHINES.md#lodge-induction-lifecycle),
  [membership lifecycle invariants](DOMAIN_INVARIANTS.md#membership-lifecycle),
  and [concurrency and locking](CONCURRENCY_AND_LOCKING.md).
