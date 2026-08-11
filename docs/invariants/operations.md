# Operations

Audience: Developer, Agent.

Prefix defined in this file: **`INV-OPS`** — raw SQL result shapes and row
locking, production deployment including the worked windowed column drop,
changing what values already stored in a column mean, and what may be used as
test input.

Read this file when you are writing raw SQL, taking a row lock, dropping a
column, changing the meaning of a stored value (an audit `category`, a status
string) so that the rows already written no longer match the code, deploying to
production, or choosing credentials or data for CI and local validation.

`INV-OPS-005` to `INV-OPS-011` are the `FamilyGroupMember.role` column drop,
re-homed here from `membership-lifecycle.md` by #2706: they are migration
policy — Prisma `@ignore` behaviour, what a generated client can emit, the
`old_code_compatible=windowed` ledger row, the `rollback.sql` and the operator
sequence — rather than membership lifecycle. The membership-lifecycle rules they
sat beneath stay where they were.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added.

`INV-OPS-012` (#2751) is the exception, because it was written here rather than
moved into the restructure: there is no source text to preserve it against, so it
is corrected and extended like any other prose, in its own reviewable change. See
[`SCHEME.md`](SCHEME.md) §3 — the no-rewording rule governs transcriptions, not
rules first written here. #2765 extended it with the measured-audience half.

## INV-OPS-001

- **Raw SQL never declares its own result shape (#2289).** `$queryRaw<SomeRow[]>`
  is an unchecked CAST: raw SQL returns the *physical* column names while the
  type argument declares whatever the author believed, and nothing verifies the
  two agree — not the compiler (the cast silences it) and not the tests (a mocked
  Prisma returns the author's own wrong belief). Where they disagreed in a live
  deployment every property arrived `undefined`, which is quietly falsy in
  exactly the comparisons that guard money: a promo's total-redemption cap never
  fired (`undefined !== null` true, `n > undefined` false) and FREE_NIGHTS promos
  applied no discount at booking creation (`?? 0`), while the quote path — an
  ordinary mapped Prisma read — showed the member one.

  Two disciplines close it, and both are enforced. **Lock raw, read typed:** a
  raw statement taken for a row lock selects a CONSTANT through `$executeRaw`
  (`SELECT 1 … FOR UPDATE`) and the data is read back through the Prisma model
  under that same lock — one extra round trip, and Prisma owns the mapping so the
  names cannot drift. The two statements are behaviour-identical to one
  `SELECT the-columns … FOR UPDATE` *while the lock matches a row*; where the
  lock key is MUTABLE, the affected-row count `$executeRaw` returns must also be
  checked, because `FOR UPDATE` locks nothing when it matches nothing and the
  follow-up read (READ COMMITTED, fresh snapshot) could otherwise return a row
  nothing holds a lock on. Only `booking-create-promo.ts` locks on a mutable key
  (`PromoCode.code`); every other site keys on an immutable cuid.
  **Validate what you cannot model:** a statement Prisma genuinely cannot express
  (only the rate limiter's atomic `CASE … RETURNING` upsert) passes its rows
  through `decodeRawRows` (`src/lib/raw-sql-rows.ts`), which throws naming the
  offending column — and which also records what Postgres really sends on this
  stack, since `COUNT(*)`/`int8` arrive as a **BigInt** (arithmetic on which
  throws) and `numeric`/`decimal` as a **`Prisma.Decimal`**.

  `eslint` `no-restricted-syntax` rules refuse the type argument and a
  `SELECT *` in a raw statement — in either call form, tagged template or
  `Prisma.sql` composition — across non-test code in `src/`, `scripts/` and
  `prisma/`; `src/lib/__tests__/raw-sql-shape-guard.test.ts` scans the same three
  directories, pins the per-file inventory of raw READS, requires at least one
  `decodeRawRows()` call per raw read or a documented opt-out (only the two
  `SELECT 1` connectivity probes), and holds every `FOR UPDATE` to `$executeRaw`
  over a constant. Tests are exempt from both by design. Full protocol in
  `docs/CONCURRENCY_AND_LOCKING.md` -> "Lock raw, read typed".

## INV-OPS-002

- Production deployment must respect `docs/BLUE_GREEN_MIGRATION_POLICY.md`.

## INV-OPS-012

- **Reclassifying an audit row's `category` in code changes only the rows written
  afterwards, so the pull request that reclassifies either ships the backfill for
  the rows already written or files it as an issue — never neither, and never as
  prose. A backfill that would cross the member-visible boundary in either
  direction needs its own owner decision rather than following this rule
  automatically.** Owner decision of 10 August 2026 on #2751, decision C, in the
  variant #2763 informed; a follow-up that exists only as a sentence in a pull
  request is not a follow-up.

  **Why the code change is never the whole change.** `AuditLog.category` is
  stored on the row at write time and never re-derived at read time, and
  `buildAuditCategoryWhere`'s legacy action-name fallback fires only for rows
  whose category IS NULL — so a row that already carries a category keeps the
  superseded one for as long as it is retained. Moving a writer therefore splits
  that event's history at the release boundary: Admin > Audit Log's Category
  filter answers "show me what happened that weekend" for one side of the date
  only, and of the two AI Diagnostics correlation entries involved, the one that
  gained the writer returns the newer half while the one that lost it returns the
  older half. Neither is wrong about what it holds and neither can answer the
  question. #2730 moved 22 bed-allocation writers and produced exactly that;
  #2751's backfill closed it. The population most likely to move next is the
  lodge-gated group left at `admin`, which is why this is a rule rather than a
  note on one issue.

  **What a backfill has to be.** An EXACT literal list of the action names the
  moved sites write, never a prefix or pattern match: a pattern cannot be
  reviewed against the audit-writer census and it sweeps up any action added
  after the migration was written, including one deliberately classified
  somewhere else. `category` is the only column in the `SET` clause —
  `retentionClass` and `expiresAt` are stored columns that were derived from the
  category at write time, and recomputing them from the new value is how a
  rewrite silently re-dates when a row is purged, with no undo on an append-only
  table. Idempotent, because `prisma migrate deploy` runs before cutover and the
  old colour keeps writing the old category until it drains, so the operator has
  to be able to run the statement again. And it records what it moved, with the
  row counts before and after, because a rewrite of an append-only table is
  otherwise invisible to the club whose history it changed.

  **The member-visibility carve-out, which is the half of this rule that is NOT
  automatic.** A backfill crossing the member-visible boundary is a visibility
  decision rather than a tidy-up: rewriting a stored row OUT of a member-visible
  category (`account`, `security`, `booking`, `payment`, `family`,
  `communication`, `privacy` — the reviewed list in
  `MEMBER_VISIBLE_AUDIT_CATEGORIES`) withdraws an entry a member can see about
  their own account today, and rewriting one INTO a member-visible category
  publishes an administrator's action to the member it was about. Neither follows
  from the writer decision, so neither may ride along with it, and neither may be
  taken by a lane: **it is the owner's decision.** #2763 is the worked example —
  the same mechanism as #2751 with the opposite answer, because those rows are
  member-visible and stay untouched. #2751's own rows cleared this because neither
  `admin` nor `lodge` is member-visible, so nothing crossed in either direction.

  **Enforcement is partial, and the boundary is stated rather than implied.** The
  mechanical half exists and is real:
  `src/lib/__tests__/bed-allocation-audit-category-backfill.test.ts` fails when
  the #2751 backfill's literal action list and the writers pinned in
  `REVIEWED_ADMIN_CATEGORIES_2730` stop naming the same events in either
  direction, so adding a 23rd bed-allocation writer without covering its rows
  fails CI by name. **The remedy for that failure is a NEW backfill migration, or
  a filed issue — not an edit to the #2751 one**, because
  `docs/BLUE_GREEN_MIGRATION_POLICY.md` binds committed migrations never to be
  edited retroactively: Prisma records a checksum per applied migration, so
  editing one breaks `prisma migrate deploy` on every fork that already ran it.
  Extending the existing literal list is correct only while that migration is
  still unreleased and unapplied anywhere. A GENERAL "did a reclassification ship
  without a
  backfill" check is **not available**, and pretending otherwise would be worse
  than having none: the audit-writer census pins only 122 of its 429 write sites
  per-site — the union of `APPLIED_AUDIT_CATEGORIES`,
  `REVIEWED_ADMIN_CATEGORIES_2730`, `MEMBER_RECORD_ADMIN_CATEGORIES_2755` and
  `LODGE_GATED_ADMIN_CATEGORIES_2765`, counted rather than added up, and asserted
  by `audit-writer-census.test.ts` so this figure and the copy of it in
  `bed-allocation-audit-category-backfill.test.ts` cannot go stale again —
  deliberately, because pinning all of them would make every feature that records
  something edit a 400-line literal — so for the other 307 there is no baseline
  a check could compare against, and the category distribution alone cannot see a
  reclassification that another one compensates for. The two `verify` gates that
  can read a pull request parse its BODY, not its diff. So outside the pinned
  population this is a rule a reviewer applies, and the reviewer is the
  enforcement.

  **The same pull request also states the MEASURED before/after audience, per
  site.** Owner decision of 11 August 2026 on #2765, D3, extending this rule
  rather than adding a second one: recategorisation work carries both halves — the
  backfill answer for the rows already written, and the audience answer for the
  rows written next. Measured means run against every reader that keys on
  `category`, and stated per site rather than per group:
  `MEMBER_VISIBLE_AUDIT_CATEGORIES` and `buildMemberVisibleAuditLogWhere` for the
  member self-timeline; `AUDIT_CATEGORY_CORRELATION_DOMAIN` with
  `AUDIT_CORRELATION_DOMAIN_AREAS` for which AI Diagnostics
  correlation entries can return the row and which admin areas that needs;
  `AUDIT_TIMELINE_CATEGORY_OPTIONS` for which tab of Admin > Audit Log surfaces
  it; `FINANCE_AUDIT_CATEGORIES` in
  `src/lib/diagnostics/tools/packs/finance-records.ts` for any move into `payment`
  or `xero` on a `Payment`, `Booking`, `ManualRefundTask` or `MemberSubscription`
  entity, because that is a SIXTH audit-category reader outside the correlation
  pack and its gate is `finance` **alone** — deliberately weaker than the
  correlation entries' `support` + `finance`, per #2377's owner decision that a
  Finance Officer must not need Support & System permission, and pinned in
  `finance-pack.test.ts`; and `classifyAuditRetention` on the site's OWN action,
  since that function
  reads action as well as category and an access-shaped action expires at 24
  months instead of seven years. **The reason this is a rule is that reasoning
  about it has already failed.** #2755's issue text and the brief for its build
  lane both stated that the change moved nobody's readership; measurement on
  #2764 found three deltas, including a widening that appeared in neither. A
  sentence asserting "this changes nobody's readership" is not evidence, and on
  this surface the cost of being wrong is a row published to a member on an
  append-only table. The same measurement is what refused a move on #2765: the
  category the decision named turned out not to exist, and every category that
  reached the intended reader was member-visible (`INV-PRIV-013`). A refusal is
  not the end of the obligation — the question went back to the owner as **#2777**,
  a filed issue with the measurement and the costed alternatives, because a
  carry-forward named in a pull request and nowhere else is the defect #2765 was
  itself opened to fix. #2777 was decided on 11 August 2026; `INV-PRIV-013`
  records the settlement.

## INV-OPS-005

Why the runtime half needed the `@ignore` rather than just deleting the call
sites, recorded because the same trap applies to the next doomed column.
Measured against Prisma 7.9.0 by recording the SQL through a driver adapter:

- A static `@default("MEMBER")` is materialised **client-side** as a bind
  parameter, so the column appeared in the column list of every `INSERT` the
  client emitted — `create`, `upsert`'s insert branch and `createMany` alike —
  **even for a call that set no role and narrowed itself with
  `select: { id: true }`**. Narrowing cannot reach that: it is the write's
  column list, not its projection.
- An unnarrowed `create`/`update`/`upsert`/`delete` names every scalar in its
  implicit `RETURNING`, and an `include:` (or a bare `: true`) on the join table
  names every scalar in its `SELECT`.

`@ignore` closed all of those at once, which is what let the drop be reasoned
about at all. Removing the field outright now does the same thing permanently:
**no call shape on this delegate can emit SQL naming the column**, because the
generated client has no such field to put in a `SELECT`, an `INSERT` column
list, a `RETURNING` or a `WHERE`.

## INV-OPS-006

How that is enforced, measured in the rehearsal rather than asserted, because
the convenient shorthand ("it is a compile error now") is not quite true and the
difference decides how much guard coverage is still owed:

- `where: { role: ... }` **is** a compile error —
  `'role' does not exist in type 'FamilyGroupMemberWhereInput'`;
- `select: { role: true }` and `create({ data: { role } })` **compile cleanly**,
  and are rejected at runtime by the client with `PrismaClientValidationError`
  **before any SQL is emitted**.

So the residual hazard is a 500 on one route, not a Postgres 42703, and it is
unconditional rather than data-dependent — the first invocation of that code
path fails, in any test or dev run. What is gone completely is the *implicit*
hazard the old guard existed for: an `include:` or a bare `: true` naming the
column with no author intent at all. The client cannot name a field the schema
does not declare.

## INV-OPS-007

`src/lib/__tests__/family-group-role-retirement.test.ts` survives the drop in
reduced form. Its delegate, nested-relation and write/read scans were deleted on
the reasoning just above — the implicit hazard is structurally impossible and the
explicit one is loud and unconditional — and `familyGroupMember` came out of
`src/lib/__tests__/doomed-column-select-guard.test.ts`'s
`NARROW_SELECT_MODELS` at the same time. What it still pins is the part the
compiler cannot reach: the **generated client's shape** (the owner-required proof
that the replacement runtime cannot name the dropped column) and **raw SQL**,
where a `$queryRaw` or a psql heredoc naming the column is invisible to
TypeScript. It also ties the schema's field-absence to the committed migration
and to the migration's `windowed` ledger row with its `rollback.sql`.

## INV-OPS-008

Worth recording precisely, because the #2284 close-out is easy to misread: what
#2284 removed was the last **authorisation** reader. **Payload** readers
outlived it and were found by #2520 — every admin family-group response
(`GET`/`POST /api/admin/family-groups` and `GET`/`PUT
/api/admin/family-groups/[id]`) returned a per-member `role`, and
`GET /api/member/onboarding` selected the column explicitly and returned it to
the member-facing onboarding wizard as `groupRole`. None was rendered (the
wizard declared `groupRole` in its type and never used it; the admin pages never
referenced it), so removing them changes no screen — but "the column has no
reader" was not true of the deployed release until PR #2565, and the drop's
safety depends on it being true. A retired audit script
(`scripts/audit-access-role-membership-cleanup.ts`) also still named the column
in raw fixture SQL and a snapshot query; #2520 removed those the same way #2130
removed that script's `AgeTierSetting.xeroContactGroupId` references.

## INV-OPS-009

**How the drop actually shipped, and why the plan changed.** An earlier version
of this text described a deliberately two-step retirement: deploy the runtime
half, wait for it to become the draining colour, then drop the column in a later
release declaring `old_code_compatible=yes`. **The owner superseded that on
3 Aug 2026** (#2520): the physical drop ships now, as part of the Tokoroa
cutover, behind an accepted maintenance window, rather than carrying an obsolete
column through another release. This paragraph replaces the old plan rather than
sitting beside it, because no release ever shipped under it — the "leave it as
declared" convention in `docs/BLUE_GREEN_MIGRATION_POLICY.md` protects the record
of what operators actually deployed under, which this was not.

## INV-OPS-010

What that means concretely, and it is the honest version of the constraint the
old plan was designed to avoid:

- The runtime half was **never deployed on its own**, so the release in
  production when the drop lands is the last tagged one, whose Prisma client
  names the column in ordinary projections, in every insert's column list, **and
  in a `WHERE` clause** — `role: "ADMIN"`, the one-step partner declaration read
  that the member profile page renders. The moment the DROP commits, that release
  fails across the whole family surface.
- So the ledger row is `old_code_compatible=**windowed**`, not `yes`: it says in
  writing that the previous release *will* break, and it carries the full ordered
  maintenance-window plan. `previous_expand_release` names an adjacent migration
  in the same release, because **no truthful value exists**: the runtime half
  shipped no migration of its own, so there is no folder from it to name, and the
  field is single-valued and checked only for non-emptiness. The real precondition
  is written out in the row's `lock_impact_plan` instead. That last part is the
  practice the #2130 contract row (`20260721130000`) established — its own single
  field could not express two expand releases either, so it named one and
  explained both in the plan column — but #2130's field names a *real, already
  deployed* expand release, which this one's cannot.
- The rollback boundary moves back to the **migrate step**, so
  `rollback.sql` ships beside the migration and was rehearsed both ways. It
  restores the column's exact shape (`TEXT NOT NULL DEFAULT 'MEMBER'`) but not
  the per-row labels, which no script can recover; `'MEMBER'` is the documented
  safe compatibility value. The operator sequence, the four pre-migration checks
  and the rollback-boundary rules are in
  `docs/PRODUCTION_UPGRADE_RUNBOOK.md` → "Windowed migration deploy sequence"
  → §2.4.1.

## INV-OPS-011

The stored values were **meaningless rather than frozen** for the whole interval
between #2284 and the drop: nothing read them, and every row inserted after the
runtime half took `'MEMBER'` from the database default because the client had
stopped naming the column. That is why destroying them costs nothing
behaviourally.

## INV-OPS-003

- Public CI and local validation must use test/demo credentials or placeholders.

## INV-OPS-004

- Production data, production backups, live provider accounts, and live webhooks
  are not valid exploratory test inputs.
