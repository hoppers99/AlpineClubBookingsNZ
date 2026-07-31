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

### Freeze related writers before the final dry run

The table lock covers direct insert, update, and delete statements against
`MemberInduction`; it does not freeze the member population or every earlier
step of a larger workflow. Arrange an operator freeze from the start of the
**final** dry run until apply finishes. This is a freeze on every route, import,
and background job that can change who is eligible, which tier they occupy, the
required sign-off count, or the template the baseline will use. Pause:

- individual member edits and bulk member updates that can change `role`,
  `active`, date of birth, or `ageTier`;
- membership-application approvals, admin-created members, and members created
  through family requests;
- CSV and other member imports, including Xero member imports;
- membership-assignment saves and roll-forward jobs that can update
  `ageTier`;
- archive, cancel, reactivate, delete, merge, and every other member lifecycle
  operation;
- induction creation, signer assignment or reassignment, sign-off, admin
  completion or override, void, and delete; and
- changes to club identity, age-tier settings, nomination settings, or
  induction-template content and activation.

Do not assume the `MemberInduction` table lock covers any of the member,
eligibility, or configuration writers above. If the dry run finds a blocker,
end the final-run attempt, resolve it, then start a new freeze and generate a
fresh final dry run. Do not review one plan while those writers continue and
later apply it as though the population and configuration were unchanged.

## 1. Run and retain the dry-run report

On a supported Compose deployment, run the command from the pinned migrate
image for the deployed commit. This uses the Compose-internal `postgres`
hostname and does not publish a new database port or require Node/npm on the
host:

```bash
docker compose run --rm migrate \
  ./node_modules/.bin/tsx scripts/induction-baseline.ts \
  --actor-member-id <full-admin-member-id> \
  --baseline-date <YYYY-MM-DD> \
  --provenance-note "<legacy register and committee-authorisation reference>" \
  --json
```

Confirm `MIGRATE_IMAGE` names the same reviewed commit as the deployed app
before a live run. Do not substitute an unreviewed local image. Compose supplies
`DATABASE_URL` inside the container; do not override it on the command line or
enable shell tracing.

For a local rehearsal with the repository's supported Node version and a
sanitised non-production database, use:

```bash
npm run induction:baseline -- \
  --actor-member-id <full-admin-member-id> \
  --baseline-date <YYYY-MM-DD> \
  --provenance-note "<legacy register and committee-authorisation reference>"
```

To rehearse entirely in containers, create a separate staging Compose project,
start its new database, and build the migrate image:

```bash
cp .env.staging.example .env.induction-rehearsal
# Set a unique DB_PASSWORD and STAGING_POSTGRES_PORT in this local-only file.
docker compose --env-file .env.induction-rehearsal \
  -p induction-baseline-rehearsal \
  -f docker-compose.yml -f docker-compose.staging.yml up -d postgres
docker compose --env-file .env.induction-rehearsal \
  -p induction-baseline-rehearsal \
  -f docker-compose.yml -f docker-compose.staging.yml build migrate
```

Restore only a sanitised non-production copy into that separate project, then
bring it to the current schema:

```bash
docker compose --env-file .env.induction-rehearsal \
  -p induction-baseline-rehearsal \
  -f docker-compose.yml -f docker-compose.staging.yml run --rm migrate
```

Replace `docker compose` in the deployed dry-run command with the full
`docker compose --env-file ... -p ... -f ... -f ...` prefix above. The staging
override binds PostgreSQL to `127.0.0.1` only, never to an external interface.

The date is a New Zealand date-only lodge date and cannot be later than the
current New Zealand date. The note is stored with the stable prefix
`Trusted legacy induction baseline:` on every new row, so choose wording that
remains meaningful as a permanent audit record.

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

For each opaque member ID under `OPEN_WORKFLOW`, sign in to the admin site and
open `/admin/members/<member-id>` directly. That authenticated page lets you
verify whose ID it is without adding identity data to the CLI output. Then open
`/admin/induction`, search using the identity shown on the member page, and
complete or void the open workflow according to the evidence. Never append a
member's name or email to the retained CLI report; it intentionally contains
IDs only. After resolving blockers, restart the writer freeze and run a fresh
final dry run.

Stop if the club, database host, database name, population, template, date, or
provenance is not exactly what you expected. Resolve the discrepancy and
generate a fresh dry run. Do not edit a saved report and treat it as current.

## 2. Apply with exact confirmations

Use the exact effective club name, parsed host, and database name printed by
the reviewed dry run. On the supported deployment path:

```bash
docker compose run --rm migrate \
  ./node_modules/.bin/tsx scripts/induction-baseline.ts \
  --apply \
  --actor-member-id <full-admin-member-id> \
  --baseline-date <YYYY-MM-DD> \
  --provenance-note "<same legacy register and committee-authorisation reference>" \
  --confirm-club-name "<exact club name from the dry run>" \
  --confirm-db-host "<exact host[:port] from the dry run>" \
  --confirm-db-name "<exact database name from the dry run>" \
  --json
```

For the local Node rehearsal path, use the same arguments after
`npm run induction:baseline --`.

All confirmations are case-sensitive and exact. Apply validates the actor,
configuration, template, and population again. It then locks the
`MemberInduction` table against direct concurrent insert, update, and delete
statements before re-reading and classifying every row. Direct DML already in
progress finishes before the locked read; direct DML that reaches the table
later waits until apply commits. The lock does **not** serialize earlier member
creation, import, approval, lifecycle, or configuration steps, which is why the
operator freeze is required. A timeout, lock error, changed club or database
target, invalid configuration, or open workflow visible under the lock fails
the whole transaction.

Supply each mode and value flag exactly once. If apply is blocked and `--json`
was requested, the command still prints the human report and safe JSON between
the marker lines, then exits nonzero. Treat that as a failed apply.

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
