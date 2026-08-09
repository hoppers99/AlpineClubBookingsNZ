# Operations

Audience: Developer, Agent.

Prefix defined in this file: **`INV-OPS`** — raw SQL result shapes and row
locking, production deployment, and what may be used as test input.

Read this file when you are writing raw SQL, taking a row lock, deploying to
production, or choosing credentials or data for CI and local validation.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`_PHASE1_SCHEME.md`](_PHASE1_SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused. **The text under each ID is a
verbatim move from the source document and must not be reworded in place** —
only the ID heading lines were added.

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

## INV-OPS-003

- Public CI and local validation must use test/demo credentials or placeholders.

## INV-OPS-004

- Production data, production backups, live provider accounts, and live webhooks
  are not valid exploratory test inputs.
