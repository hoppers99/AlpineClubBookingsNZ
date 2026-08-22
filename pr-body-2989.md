## Linked Issue

- Closes or relates to: Closes #2989 (CT-1). Parent epic: #2988 (`CT` — Club Time). This is CT-1 only — no CT-2 kernel, no display call-site migration, no `APP_TIME_ZONE` retirement.

## Summary

- **One persisted IANA club timezone per installation, and it is now the only thing that decides what time it is at the club.** It lives in a new `ClubTimeSettings` singleton, is chosen during setup, is read through one server-owned function, and afterwards is changed only by a Full Administrator through a confirmed, audited action that rewrites nothing.

- **Which settings model owns the field, and why it is a new one.** There is no general installation-configuration model in this schema, and that is the schema's shape rather than an omission: configuration lives in one *domain-scoped* singleton per domain — 25 of them today, each `id String @id @default("default")` with `updatedByMemberId` and timestamps and a `src/lib/<domain>-settings.ts` reader beside it. `ClubTimeSettings` is that established pattern, not a parallel general store, and `src/lib/config-transfer/singleton-models.ts` enumerates the family mechanically from the schema so a new one cannot join config transfer's blind spot unnoticed. The alternative considered was a column on `ClubIdentitySettings`, and it was rejected on four counts, each the opposite of what this field needs: that model is the club's *branding* identity (name, short name, hut-leader label, Facebook URL); it is gated on `content:edit` where this must be Full Admin; every column is a **nullable override** over a live `config/club.json` fallback where this must be non-null once written; and nothing backfills it from the environment where this must be seeded from it exactly once. Sharing one row would also make that row's `updatedByMemberId` / `updatedAt` report the wrong actor for whichever of the two surfaces wrote last. A new table has one further concrete benefit: `timeZone` is `NOT NULL` immediately, because the row's existence *is* the "configured" signal — so no contract-phase migration is needed to get there.

- **Validation is an IANA identifier shape plus a runtime probe — deliberately NOT `Intl.supportedValuesOf` membership.** Measured on Node 24.15.0 in this worktree, that list holds 418 zones and is **not canonical across ICU versions**: it contains `Asia/Calcutta` and not `Asia/Kolkata`. Both spellings are accepted by `Intl.DateTimeFormat` on every engine, so validating by membership would let an ICU upgrade turn a perfectly good *stored* zone into an invalid one. Instead a value must have an IANA identifier shape (verified against all 418, every one of which contains a `/` — which is what rejects the entire single-word alias family in one stroke: `NZ`, `Japan`, `EST`, `UTC`, `GMT`, `Zulu`, `PST8PDT`), must be accepted by `Intl.DateTimeFormat`, and must still satisfy the shape rule after the runtime canonicalises it. The input's shape is judged **before** the probe, which is load-bearing: `Intl` resolves `EST` happily, to `America/Panama`. `Etc/*` and `SystemV/*` are refused **by name**, because `Etc/GMT-14` and `SystemV/EST5` both satisfy the shape and both resolve to themselves — exactly the "fixed offset in a spelling `Intl` accepts" the issue names. The list is still used for the selector's *options*, where it is the right source.

- **The migration seeds no row, on purpose, and that is the substantive decision in it.** A SQL migration cannot read `process.env.TZ`, so inserting `'Pacific/Auckland'` would silently reassign the civil time of every club running on any other zone. Instead a create-if-absent boot step copies the zone the deployment is **already effectively using**. `Pacific/Auckland` is the generic New Zealand distribution default and applies only where no prior effective configuration exists at all.

- **`TZ` / `NEXT_PUBLIC_TZ` are demoted to a seed.** They are consulted only when nothing is persisted — the window between `prisma migrate deploy` and the first boot of the upgraded release. `APP_TIME_ZONE` remains for the display call sites CT-2 to CT-5 migrate; it is marked transitional and retired by CT-6 (#2991), and `club-time-zone-env-agreement.test.ts` pins the two readings to the same variables in the same precedence so they cannot drift while both exist. **Nothing here touches the process or container timezone**, which is the fix this epic explicitly rules out.

- **One file was split rather than ratcheted.** `src/lib/config-self-heal.ts` was 683 lines against a 700 budget on `main`, and the size-allowance mechanism explicitly refuses a file crossing its budget for the *first* time. Its five step definitions moved to a new `src/lib/config-self-heal-steps.ts` (417 + 518, both clear), re-exported from the original module under their original names, so no importer, document or schema comment changed.

## Risk Level

- [ ] Critical
- [x] High
- [ ] Medium
- [ ] Low
- [ ] Informational/docs only

## Changed Areas

- [ ] Booking/capacity
- [ ] Payment/refund/credits
- [ ] Membership/family lifecycle
- [ ] Xero/Stripe/SES/Sentry integration
- [x] Auth/security/privacy
- [x] Admin/finance/lodge UI
- [ ] Public UI/UX/accessibility
- [x] Database schema/migrations
- [x] Deployment/operations
- [ ] Docs/agent workflow only

## Tests Added Or Updated

- **New — `src/lib/__tests__/club-time-zone.test.ts`** (53 tests). Accepts `Pacific/Auckland`, `Australia/Sydney`, `America/New_York`, `Pacific/Chatham`, three-segment `America/Argentina/Rio_Gallegos`, and case variants. Refuses `""`, whitespace, `NZT`, `NZST`, `EST`, `EST5EDT`, `PST8PDT`, `UTC`, `GMT`, `Zulu`, `NZ`, `Japan`, `+12:00`, `UTC+12`, `Etc/GMT+12`, `Etc/GMT-14`, `Etc/UTC`, `SystemV/EST5`, `Pacific/Auckland/`, `/Pacific/Auckland`, `Pacific//Auckland`, a 65+ character value, an interior NUL and an interior newline. Deprecated aliases naming a real place (`US/Pacific`) are asserted to normalise to *a valid club zone* rather than to one ICU's spelling, so an ICU upgrade cannot fail the suite. Plus a guard that the shape rule matches **every** zone in `Intl.supportedValuesOf("timeZone")`, so a future tightening that excluded real zones fails here.
- **New — `src/lib/__tests__/club-time-zone-settings.test.ts`** (15 tests). The persisted row wins while `process.env.TZ` says otherwise, **paired with its premise leg**: with no row, the reader returns the environment's zone. Without that second leg the first assertion cannot discriminate a real precedence rule from an environment read that never happens. Mutation evidence lives in the test: with a row persisted, `TZ` moves through three zones, `readEnvironmentClubTimeZoneSeed()` is asserted to move each time, and the answer is asserted to hold still.
- **New — `src/lib/__tests__/club-time-zone-env-agreement.test.ts`** (9 tests). A total pin of `(readEnvironmentClubTimeZoneSeed() ?? CLUB_TIME_ZONE_FALLBACK) === APP_TIME_ZONE` across eight environment combinations, so the seed and the transitional constant cannot drift while both exist. States its own limit: it cannot see a *third* variable added to only one reading.
- **New — `src/lib/__tests__/config-self-heal-cli.test.ts`** (3 tests). The out-of-band script prints step results on a provenance-skipped run and still exits non-zero. Two mutations were invisible before this file existed.
- **New — `src/app/api/admin/club-time-zone/__tests__/route.test.ts`**. Full Admin can read and change; a `support:edit` grid, a grid holding **every area at `edit` without the `ADMIN` role**, and an anonymous caller are all refused with nothing written. Missing/false `confirmed` → 400. Invalid values → 400. A valid change writes exactly one audit row whose metadata **key set** is asserted, not merely its values. Re-saving the stored value writes nothing. The write transaction is asserted to touch only `ClubTimeSettings` and `AuditLog` by enumerating every other Prisma delegate spy. It exercises the **real** guard, matrix and audit builder — `@/lib/session-guards` is deliberately not mocked.
- **New — `src/components/admin/__tests__/club-time-zone-panel.test.tsx`**. Renders the server-supplied zone; does not persist on selection alone; Save stays disabled until the acknowledgement is ticked; shows the consequences text; and never derives the current zone from `Intl.DateTimeFormat().resolvedOptions()`.
- **New — `prisma/migration-verification/20260822010000_add_club_time_settings.ts`**. Pins the table's shape and that it is **empty**, with three mutants.
- **Updated** — `config-self-heal.test.ts` (51 tests, +14), `setup-readiness.test.ts` (37, +12), `setup-wizard-db.test.ts` (26, +11), `member-merge-dmmf.test.ts`, `audit-writer-census.test.ts`, `admin-route-area-matrix.test.ts`, `admin-sidebar.test.tsx`, `contextual-help.test.ts`, `bed-allocation-audit-category-backfill.test.ts`.

**Mutation evidence — 19 mutations applied to the setup/backfill lane, 19 detected**, restores verified by SHA-256 rather than by `git` (a `git checkout --` in a shared worktree discards unrelated uncommitted work). The load-bearing ones: removing the timezone step's provenance exemption is caught by 3 tests including both both-halves cases; changing its `update: {}` to `update: { timeZone }` is caught by the never-overwrite test; flipping `defineSelfHealStep`'s `?? true` default to `?? false` is caught by 9 tests, i.e. the four `club.json` steps stop being guarded; reverting the runner to its old return-early is caught by both both-halves cases; and dropping the step from `SELF_HEAL_STEPS` is caught by 6. On the admin lane, changing `permission: false` to an omitted `permission` **and separately** to `"any-admin"` each fails exactly the four authorisation-refusal tests, disabling the confirmation check fails 2, disabling the dirty gate fails 1, adding one extra `metadata` key fails 2, and adding a `tx.booking.updateMany` inside the transaction fails the two-table footprint test.

## Validation Commands Run

```bash
# Prisma client regenerated against the new schema first — a stale client
# type-checks clean while CI fails.
npm run db:generate                                    # OK

npm run lint                                           # 0 errors, 54 warnings (all pre-existing, none in a changed file)
npm run typecheck                                      # clean, both tsconfig.json and tsconfig.test.json
npm run knip                                           # exit 0
npm run quality:budget                                 # OK — 18 production files changed; the only growth is the 4 declared allowances
npm run docs:indexcheck                                # passed (506 invariant ids, 36 routing rows, every docs/ page reachable)
npm run docs:linkcheck                                 # all relative links and anchors resolve
bash scripts/check-migration-safety-coverage.sh        # passed (209 ledger rows, 19 in-scope migrations)
bash scripts/check-data-migration-verification.sh      # passed

# The whole diff through the module graph — the mandatory gate.
npx vitest related --run $(git diff --name-only origin/main...HEAD)
#   781 test files passed | 1 skipped, 13,243 tests passed | 382 skipped, 0 failures

# The nine new/changed suites in this change, in isolation.
npx vitest run <the nine club-time / setup / self-heal suites>   # 9 files, 234 tests, all pass

# Against a REAL PostgreSQL (a throwaway lane-owned container on port 55489;
# 5432 is deliberately untouched on this host).
prisma migrate deploy                                  # all migrations applied, including this one
prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
#   "No difference detected." — the migration reproduces schema.prisma exactly
npx vitest run src/lib/__tests__/data-migration-verification.realdb.test.ts
#   128 tests pass. Verbose output confirms the new fixture RAN and that all three
#   declared mutants, the runner's own not-applied mutant, and its
#   "proves a mutant by a row MISMATCH, not just a raised error" check all passed.

# The hand-written migration SQL was compared to Prisma's own generated DDL
# (prisma migrate diff --from-empty --to-schema) and is byte-identical.

npx tsx scripts/audit/audit-writer-census.ts           # re-measured: 453 -> 454 sites, admin 102 -> 103
```

Every local run set `DATABASE_URL` to an unreachable placeholder (`postgresql://user:pass@127.0.0.1:1/none`) except the two real-Postgres steps above, which used the throwaway container. **This worktree has no `.env`, and an unset `DATABASE_URL` produces a FALSE failure** in one capacity self-heal test (`getLodgeCapacityStatus` → `requireDatabaseUrl()` throws → the capacity step's `isPresent` catch treats it as "resolves to 0"). That was proved pre-existing by running the committed `origin/main` versions of both files, and proved environmental by re-running with the variable set (51/51 pass).

## Commands Not Run And Why

- `npm test` (the full suite) and `next build` — CI owns both, per `AGENTS.md` §5. `vitest related` over the whole diff is the local gate, and it selects by the module graph rather than by filename.
- Playwright E2E and the multi-lodge E2E — CI owns them. No E2E spec covers this surface yet; the admin page is Full-Admin-only and the E2E personas do not include one.
- `npm run docs:screenshots` — the capture harness needs the seeded staging stack, and `/admin/club-time` is not in its manifest. The new guide therefore carries no screenshot and says so, which is the same position as 8 of the 70 existing guides including the most recent (`maintenance-reports.md`, #2780).
- No production credentials, production database, production backup, live Stripe, live Xero, live SES, live Sentry or live provider webhook was used at any point.

## Screenshots Or UI Evidence

- No screenshot. `/admin/club-time` is not in the screenshot harness manifest, and `docs/STYLE_GUIDE.md` forbids hand-cropped captures — a guide referencing an image that does not exist on disk also fails the CI link check. The UI is instead evidenced by `src/components/admin/__tests__/club-time-zone-panel.test.tsx`, which asserts the read-only-on-mount state, that selection alone does not persist, that Save is disabled until the acknowledgement is ticked, the consequences text, and that the panel never derives the zone from the browser. Adding the page to the manifest is a follow-up for whichever child of #2988 next runs the harness.

## Security And Privacy Impact

- **A new Full-Admin-only surface.** `GET` and `PUT /api/admin/club-time-zone` both use `requireAdmin({ permission: false })`, which per the documented contract in `src/lib/session-guards.ts` admits only `hasAdminAccess` — the `ADMIN` access role. An omitted `permission` would infer an area from the path and `"any-admin"` would admit any admitted admin; neither is used, and mutating to each of them fails the authorisation tests. `/admin/club-time` renders a "full administrators only" panel for any other admin, following `/admin/config-transfer`.
- Both prefixes are registered in `ROUTE_AREA_PREFIXES` under `support` so the route-map drift guard resolves them rather than letting them fall into the `overview` catch-all; the route's own `permission: false` is what enforces Full Admin. This is the `/admin/backups` split, stated in a comment at both entries. **No `OVERVIEW_ALLOWLIST` entry was added** — the guard passes for the right reason.
- The audit row's `metadata` is `{ before, after }` and nothing else: no request echo, no settings blob, nothing about the acting member beyond the actor id the row already carries. The test asserts the metadata **key set**, so a later addition fails.
- The `GET` returns the display name of the member who last changed the setting and nothing else about them — no email, no id beyond what the row holds.
- `ClubTimeSettings.updatedByMemberId` is declared a member-merge **snapshot** column (`INV-LIFE-078`): if that administrator is later merged away, the id stays as immutable history, because the audit answer to "who moved this club's civil time" is whoever did it at the time.
- The panel is a client component and imports only the pure validator, never the `server-only` reader; `client-server-boundary-census.test.ts` (`INV-OPS-013`) still passes.

## Data Integrity Impact

- **No existing row of any kind is read or written by the migration, and no stored temporal value is ever rewritten.** The migration is one `CREATE TABLE` plus one `CREATE INDEX` on that new table, with no DML at all. The verification fixture pins the resulting shape and that the table is empty.
- **Changing the timezone rewrites nothing.** The write transaction touches exactly two tables, `ClubTimeSettings` and `AuditLog`, and the route test asserts that by enumerating every other Prisma delegate spy and requiring it uncalled. No stored instant moves and no date-only value changes; what changes is how instants are *projected* into civil time from then on, and the club-local hour scheduled work fires at. Lodge nights keep the calendar dates they already have.
- Re-saving the currently stored value writes nothing at all — no row, no `updatedAt` bump, no audit row — and the re-read is inside the transaction so a concurrent save cannot land between the check and the write.
- The boot backfill can only ever CREATE the row (`update: {}`). A club's configured zone survives every future boot, and a `P2002` from a simultaneous blue/green double-boot is treated as already-present rather than as a failure. Both properties are tested, including a test that drives `heal()` directly so the never-overwrite guarantee is proved independently of the presence check.

## Concurrency And Lock Impact

- [ ] N/A — no transaction, lifecycle, capacity, settlement, credit, webhook,
      cron, or concurrency-sensitive writer changed.
- Writer class(es), canonical lock key(s), and acquisition order: **Installation-configuration singleton writer — no advisory lock, by classification rather than by omission.** Working through the `AGENTS.md` concurrency checklist: this is not a global-cohort lifecycle or settlement-money transition (`INV-LOCK-001` global tier does not apply — it moves no money and changes no booking, payment or membership status); it is not a capacity admission or status claim, so it takes no `acquireLodgeCapacityLock` per-lodge key (`INV-LOCK-002`); and it touches no member-night or credit-ledger invariant, so no per-member helper applies. It is the same writer class as `ClubIdentitySettings`, `LoginSecuritySetting` and every other `id="default"` settings singleton, none of which takes an advisory lock. No new lock key or global site is introduced, so `INV-LOCK-003` requires no registration.
- Immutable pre-lock key source and mutable under-lock re-read: **The key is the compile-time constant `CLUB_TIME_SETTINGS_ID = "default"`** — immutable by construction, derived from no mutable state, so there is no pre-lock resolution step to get wrong. The mutable state is the row itself, and it is re-read **inside** the `prisma.$transaction` (`tx.clubTimeSettings.findUnique` before the upsert) rather than before it, specifically so a concurrent save cannot land between the dirty-gate check and the write.
- Status-guarded claim and proof that a lost claim runs no side effect: **The admin write has no side effect to guard** — it writes one settings row and one audit row in one transaction and makes no provider call, sends no email and enqueues no job, so there is no action a lost race could perform twice. Two simultaneous Full Admins resolve as last-writer-wins on a single row, each attempt correctly audited with its own before/after, which is the established behaviour of every settings singleton in this repository. **The boot backfill is the path that does carry a claim, and it is structural rather than status-guarded:** `upsert(..., update: {})` cannot overwrite, so a lost race is a no-op by construction, and a `P2002` from the losing writer is caught and reported as already-present. Tested both by asserting a Sydney row survives an Auckland boot and by driving `heal()` directly to prove the empty `update` independently of the presence check.
- Relevant open/last-10 PR numbers, counterpart writers/tests, and compatibility evidence: **No open PRs existed when this branch was cut** (`gh pr list --state open` was empty), so there is no concurrent lane to reconcile. Branched from `origin/main` @ `bbbd8b1b3`, which contains the last ten merged PRs including #2980, #2983, #2976, #2973, #2982, #2970, #2955 and #2951. The counterpart writer this change actually composes with is the boot config self-heal, whose runner it modifies: the four pre-existing steps are byte-identical in behaviour because `defineSelfHealStep` defaults `requiresPrimaryClubConfig` to `true`, and that default is itself mutation-tested (flipping it to `false` fails 9 tests). The new `ClubTimeSettings` table has no counterpart writer at all — nothing else in the tree reads or writes it. Old-code compatibility is in the ledger row: the previously deployed Prisma client has no `clubTimeSettings` delegate, so the draining colour never names the table, and it keeps resolving club time from `APP_TIME_ZONE` exactly as it does today.
- Provider calls inside a transaction (write `None`, or justify the bounded exception from `docs/CONCURRENCY_AND_LOCKING.md`): None.

## Payment Or Accounting Impact

- None. No money value, invoice, credit, refund or provider record is read or written. Money remains integer cents; nothing in this change touches a monetary field.

## Migration Or Deployment Impact

- **`prisma/migrations/20260822010000_add_club_time_settings/`** — a purely additive expand: `CREATE TABLE "ClubTimeSettings"` plus one index on `updatedByMemberId`. No `ALTER`, no DML, no enum, no constraint on an existing table. Verified byte-identical to Prisma's own generated DDL, and `prisma migrate diff` against a real database with every migration applied reports "No difference detected." The timestamp sorts strictly above `20260821010000_add_maintenance_reports`, the highest prefix on `origin/main`, and reuses no existing prefix — re-verify on rebase.
- **Ledger row added** (`expand` / `n/a` / `old_code_compatible=no`) with the full analysis. `no` is the correct value from the policy's closed vocabulary: the SQL matches neither the breaking nor the destructive-removal patterns and `ClubTimeSettings` is not a hot table, so there is nothing to acknowledge. The row is documentation rather than a gate requirement, written because this migration is the expand half of a change whose other half runs in the application.
- **The deploy needs no window and no override.** Old-code compatible in both directions: the draining colour has no delegate for the table, and the new colour finds it empty and falls back to the same environment value the old colour uses, so both agree on the club's civil time throughout migrate → cutover.
- **One post-upgrade action, documented in `docs/UPGRADING.md`:** after cutover, confirm the **Club Time Zone** step on `/admin/setup` reads *complete* and names the expected zone. If it still reports the zone as not recorded, the app has not restarted since the migration — restart it, or run `npm run config:self-heal`.
- **`npm run config:self-heal` behaviour change:** on a `config/club.json` provenance skip it now prints the results of the steps that *did* run (the timezone step is exempt from that guard) and still exits non-zero, because a partial run is not a success. Documented in `DEPLOYMENT.md`.
- No `rollback.sql` is shipped, which is correct for an additive expand: `DROP TABLE "ClubTimeSettings"` restores the previous shape exactly and loses only the persisted zone, which no older release reads and which a newer release re-seeds from the environment.

## Docs Updated

- **New operator guide** `docs/guides/club-time.md`, following the required skeleton, plainly separating the club time zone from the server's, and stating what a change does and does not do. Linked from `docs/adopters/README.md` and `docs/guides/setup.md`; row added to `docs/COVERAGE_MATRIX.md`.
- **New invariant `INV-CONFIG-002`** in `docs/invariants/product-configuration.md`, indexed in `docs/DOMAIN_INVARIANTS.md`, with a new routing row in `AGENTS.md` for "what time it is **at the club**".
- `CONFIGURATION.md` — `TZ` / `NEXT_PUBLIC_TZ` rewritten as seed-only, and the self-heal section now covers the split and the timezone step's exemption. `.env.example` carries the same note beside the variables.
- `DEPLOYMENT.md` — the new self-heal step, and the partial-skip behaviour of the out-of-band script.
- `docs/UPGRADING.md` — an Unreleased entry: what changes, what the migration does to your data (nothing), the post-upgrade check, and the habit that stops working.
- `docs/ARCHITECTURE.md` — states the one-singleton-per-configuration-domain pattern and where the club timezone lives; `docs/TESTING.md` — that `APP_TIME_ZONE` follows `TZ` but the club timezone no longer does, and that a DB-beats-env test must include its premise leg; `docs/invariants/booking-dates-and-capacity.md` — a note under `INV-DATE-015` so the next reader of the rendering helpers knows the zone has an owner elsewhere; `docs/CAPACITY_MODEL.md` and `docs/config-transfer/README.md` — the self-heal module split; `docs/UX_FLOW_MAP.md` — the change-the-timezone journey.
- Census figures re-measured across three `src/` docblocks and eight documents (453 → 454 writers, `admin` 102 → 103, unpinned 326 → 327).
- `docs/COVERAGE_MATRIX.md`'s "70 areas" parenthetical was replaced with the rule rather than a new number: it had already drifted from its own table before this change, and I could not honestly reconcile it to a figure within this issue's scope.

## Changelog Entry

- Fragment added (`changelog.d/<pr-number>-<slug>.md`): `changelog.d/3000-club-time-zone.md`

## Residual Risks

- **None carried forward.** Two defects were found during this work and both are fixed in this branch rather than filed: `resolveClubTimeZoneWithSource` decided provenance by string-comparing the resolved zone against the raw stored text, so a stored alias or case variant (`US/Pacific`, `pacific/auckland`) would have reported a properly configured club as "using the environment's zone" — it now asks each candidate the same normalisation question the resolver asks; and my schema change broke `member-merge-dmmf.test.ts` (`INV-LIFE-078`) until `ClubTimeSettings.updatedByMemberId` was classified as a merge snapshot column.
- **Stated limits, which are not residuals** — each is a limit of what was measured, not work left undone: the ICU-dependence of `Intl.supportedValuesOf` was measured on Node 24.15.0 only, which is why validation does not depend on it; the agreement test cannot detect a *third* environment variable added to only one of the two readings, and says so in the file; `prisma/seed.ts`'s create-only upsert has no unit coverage in this repo, as its adjacent `clubIdentitySettings` seed also does not; and the interactive `askTimeZone` prompt in `scripts/setup.ts` is not itself unit-tested, though the write-path guard it feeds is, and is mutation-verified.
- **In scope for later children of #2988, not for this PR:** `APP_TIME_ZONE` still serves the ~132 display call sites in ~61 files that CT-2 to CT-5 migrate, which the issue sanctions as a transitional bridge (requirement 8) and CT-6 (#2991) retires. It is marked transitional at its definition, pinned to the seed by a test, and named in the invariant, so the bridge is disclosed and bounded rather than silent.

## Manual Checks Required

- After deploying, confirm the **Club Time Zone** step on `/admin/setup` reads *complete* and names the zone the deployment was already running on — that is the acceptance criterion this change is easiest to get wrong on, and it is a five-second check.
- Open `/admin/club-time` as a Full Administrator and confirm the current zone and its provenance read correctly; optionally open it as a non-Full-Admin and confirm the refusal panel.
- No manual database step, no operator migration action, and no configuration change is required.

## Safety Confirmation

- [x] I did not use production credentials, production databases, production
      backups, live Stripe, live Xero, live SES, live Sentry, or live provider
      webhooks for exploratory validation.
- [x] Merge handling follows the `AGENTS.md` "Completion and Merge" risk gate:
      eligible Low/Medium-risk PRs may merge (and close their linked issue) once
      CI is green; Critical or High-risk changes — security, payments, booking,
      membership, Xero/Stripe/SES/Sentry, schema/migrations, deployment, or data
      integrity — wait for explicit owner approval. Merge commits only.
