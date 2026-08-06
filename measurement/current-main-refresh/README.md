# Current-main correctness evidence producers

Audience: developer, operator, agent

This directory contains the production-shaped correctness producer suite for
issue #2352. It creates source-, image-, stack-, and database-bound raw evidence
for the 23 mandatory checks (`MC-*`) and 12 supporting checks (`BND-*`). It does
not decide the global result and does not write `COMPLETED.json`; the independent
phase-2 finalizer enumerates and hashes all evidence, scans it for secrets,
combines these observations with timing evidence, and creates the final seal.

The intended current-side **application** source and OCI revision is
`bfe53aeab6dd54ed5bfcf3636a1643451f277bef`, the merge commit for PR #2591.
That is a target identity, not a claim that a measurement has run. The runner
fails closed unless the supplied Git archive revision, source commit, OCI
revision, inspected image ID, running app image, and isolated stack agree.
The retained application baseline remains
`f442e389e0e5d4c2e18fa330b2fb155550b12871`.

There are deliberately two source archives. `APP_SOURCE_ARCHIVE` is the exact
measured product tree and differs by side. `PRODUCER_SOURCE_ARCHIVE` is one
reviewed integration commit containing this finalized producer suite and is
identical on both sides. The live worktree is allowed to execute only when it is
clean and its HEAD equals the producer-source commit. Product writer and
metadata analyses read application archive members directly; producer hashes
and both check/writer censuses come directly from producer archive members. The
three-header producer manifest binds the archive SHA-256 and commit, then lists
the exact sorted source set: all correctness sources, all phase-2 sources except
generated `results/`, the base Compose/Caddy files, and both stack files. No result may
substitute live checkout bytes for either source authority.

The frozen producer-manifest header is exactly:

```text
# schema_version=1
# producer_source_archive_sha256=<lowercase-sha256>
# producer_source_commit=<40-to-64-lowercase-hex>
<member-sha256>  <repo-relative-member-path>
```

The source portion of `inputs/immutable-inputs.json` is also fixed: `source`
contains the application commit/archive path/archive SHA-256;
`producer_source` contains the producer commit/archive path/archive SHA-256;
and the exact producer-archive members are retained as
`check_census_path`/`check_census_sha256`,
`writer_census_path`/`writer_census_sha256`, and
`producer_files_path`/`producer_files_sha256`. The independent finalizer rejects
unknown/missing fields and requires both sides to use the same producer source.

## Safety and prerequisites

Run only against the isolated `tacbookings-measure` Compose project through
Caddy at `http://127.0.0.1:8027`. The runner requires the canonical database
archive and its logical fingerprint, an immutable image reference and image ID,
and Playwright admin state created for this isolated stack. It rejects a reused
output directory and takes a single-flight lock inside the isolated PostgreSQL
container. Do not use live credentials or providers.

The project, app/PostgreSQL names, Caddy and Mailpit URLs are exact rather than
general overrides. Before the lock or any HTTP/browser traffic, the runner
validates all four container IDs against the measurement project/service,
network identity, reviewed resource limits and image reference, and exact
loopback-only ports (3003, 5435, 8027, and 8127). Docker operations use the
captured IDs; only an intentional app recreation may refresh the app ID, through
the same validation. The admin storage-state file must be an absolute canonical
regular file containing only loopback cookies/origins, and browser routing
blocks every request outside the exact measurement listener.

The browser producer requires the repository's already-installed Playwright and
axe-core dependencies. The runner itself never downloads tools. Before a real
run, follow the runtime and physical `node_modules` isolation procedure in
`docs/agents/CODEX_WORKFLOW.md`.

Clean Git does not bind ignored installed dependencies. Before the database
lock, the runner therefore writes `inputs/runtime-provenance.json`: exact Node
version/executable hash, root `package.json` and `package-lock.json` hashes,
`node_modules/.package-lock.json`, installed `@playwright/test`, `playwright`,
`playwright-core`, and `axe-core` versions/package hashes checked against both
locks, plus Playwright's Chromium version/revision and executable hash. Every
path is the exact canonical location under the current producer worktree, the
Node path is the running process executable, and the Chromium executable must
agree between the public Playwright API and an independent resolution through
that installation's registry. A provenance document for an external or nested
lookalike dependency tree is rejected. The
browser producer recomputes and compares that exact snapshot before and after
use. A missing physical install or browser executable fails before measurement;
there is no download fallback.

Example invocation from the exact source worktree:

```bash
bash measurement/current-main-refresh/run-correctness-producers.sh \
  --run-root /absolute/evidence/current-correctness \
  --run-id current-1 \
  --side current \
  --app-source-archive /absolute/inputs/current-app-source.tar \
  --app-source-sha256 <lowercase-sha256> \
  --app-source-commit bfe53aeab6dd54ed5bfcf3636a1643451f277bef \
  --producer-source-archive /absolute/inputs/producer-integration-source.tar \
  --producer-source-sha256 <lowercase-sha256> \
  --producer-source-commit <reviewed-producer-integration-commit> \
  --image-reference <repository>@sha256:<digest> \
  --image-id sha256:<docker-image-id> \
  --oci-revision bfe53aeab6dd54ed5bfcf3636a1643451f277bef \
  --database-archive /absolute/inputs/canonical.dump \
  --database-sha256 <lowercase-sha256> \
  --database-fingerprint <lowercase-logical-fingerprint> \
  --app-container tacbookings-measure-app-1 \
  --postgres-container tacbookings-measure-postgres-1 \
  --auth-state /absolute/e2e/.auth/e2e-admin.state.json
```

Use a different create-only run root for the baseline. The baseline side runs
only the route-manifest and CMS route-response bindings required on both sides;
phase 2 supplies its repeated timing and concurrency evidence.

## Producer coverage

The current side runs these producer IDs in a fixed single-flight order:

- `route-manifests`: source/image route ownership (`BND-01`)
- `cms-lifecycle`: anonymous/authenticated cache reuse, edit, unpublish,
  republish, and typed route-response evidence (`MC-02`, `MC-03A-C`, `BND-02`)
- `cache-fault`: actual 64 MiB cache tmpfs saturation and recovery (`MC-07`,
  `MC-08A`)
- `source-census`: application-archive-derived 39-writer canonical-invalidation
  contract, focused test-source evidence, representative-runtime policy, and the
  missing CMS deletion applicability finding (`MC-03D`, `MC-04D`)
- `browser-suite`: exact public-route browser, form, accessibility, metadata,
  canonical, identity-marker, and access coverage (`MC-01A-B`, `MC-06`,
  `MC-11A-E`)
- `wire-security`: cache, nonce, marker-cookie, sensitive/narrowed route matrix
  (`MC-05`, `MC-06`, `BND-04-BND-07`, `BND-11`)
- `stored-404`: the accepted #2570 stored-404 observation and clearing trigger
  (`MC-05`, `BND-12`)
- `public-layout-writers`: real theme, identity, and banner mutation/restore
  sequences against warm `/about` (`MC-04A-C`)
- `setup-transition`: exact stored CMS holding-page MISS/HIT followed by the
  authenticated `completeSetup` transition and live-content MISS/HIT (`BND-10`)
- `revalidation-300s`: real stale-while-revalidate boundary (`BND-03`)
- `warm-db`: marker-delimited PostgreSQL cold-versus-warm statement proof
  (`BND-08`)
- `adult-hosting`: one real booking-policy public-content writer (`MC-04D`,
  `BND-11`)
- `deploy-warmup`: authenticated direct-target warm-up and exact-image binding
  (`MC-10`)
- `log-noise`: complete scenario-log census with the expected ENOSPC exception
  isolated (`MC-09`)

Each producer result has the normalized observation schema plus a sorted,
complete `owned_artifacts` manifest of every regular file under its exact
`raw/<producer-id>/` directory. The finalizer must verify exact filesystem set,
size, and checksum equality; semantic `evidence_paths` are a referenced subset,
not an orphan allowlist.

## Identity, cleanup, and postconditions

Before any producer runs, the orchestrator binds both immutable source archives,
extracts the exact check and writer censuses from the producer archive, records safe projected app and
PostgreSQL container inspections, PostgreSQL server identity, the database
fingerprint, compiled `.next/server` and `.next/static` Sentry-literal scan, and
the blank runtime `NEXT_PUBLIC_SENTRY_DSN` result. It also binds the installed
runtime provenance described above. Their typed aggregates and
checksums are bound into `inputs/immutable-inputs.json`. Full Docker inspection
is deliberately not retained because environment fields can contain secrets;
the safe projections contain only identity, network, and published-port fields.

The runner extracts its source verifier from the bound producer Git commit and
builds a frozen checksum manifest from the producer archive. Before and after
every live producer, and around database restore and postcondition emission, it
first runs external strict checksum verification from the live worktree root and
then performs an archive-aware exact-set and byte comparison. The set is all of
`measurement/current-main-refresh/**`, all of `measurement/phase2/**` except
generated `results/**`, and the shared root/stack inputs. Any missing, added,
special, symlinked, or changed member fails closed. A late failure removes
`postconditions.json`, `postcondition-evidence/`, orchestrator health evidence,
and any premature `COMPLETED.json`, so changed producer bytes cannot survive as
a handoff.

Mutation producers restore their functional state and retain cleanup evidence.
They do not delete immutable audit history. After all producers finish, the
orchestrator restores the canonical archive into the disposable measurement
database, recreates the selected exact-image app, and proves that the logical
fingerprint equals its input value. It records the independently re-read stack
identity under `postcondition-evidence/`, app health at
`raw/orchestrator/app-health.json`, and the exact root `postconditions.json`.
The finalizer must seal those files before it writes `COMPLETED.json`.

## Deliberately unresolved checks

The suite reports what is observed and does not manufacture a passing result:

- `MC-03D` remains `OWNER_DISPOSITION_NEEDED`: current source has no CMS
  page-content deletion endpoint, so deletion applicability needs a direct owner
  disposition.
- `MC-08B` and `BND-09` belong to the independently repeated phase-2 timing and
  concurrency producer and are not emitted here.

## Evidence-level boundaries

`MC-04D` is a layered result: all 39 application-archive writer members must
resolve structurally to canonical invalidation and the focused contract-test
sources must match their archived hashes; the CMS, layout, banner, and adult
hosting probes supply representative real-runtime evidence. The report labels
that runtime level honestly and does not claim 39 exhaustive mutations.
`MC-11E` is also source-derived: current metadata declares no
`alternates.canonical`, so all five affected routes must render zero canonical
links. A future canonical declaration makes the contract builder stop for
review instead of silently changing the expectation.

Any unresolved, failed, missing, same-producer duplicate, orphaned,
cleanup-failed, or identity-mismatched result prevents a global `PASS`.
Distinct allowed producers may corroborate one check; the final report retains
their producer IDs and evidence rather than treating that corroboration as a
duplicate.

## Dependency-free validation

These checks validate the producer contracts without starting the stack:

```bash
node measurement/current-main-refresh/self-test.mjs
bash -n measurement/current-main-refresh/run-correctness-producers.sh
node --check measurement/current-main-refresh/bin/create-immutable-inputs.mjs
```

This directory contains producer source only. A passing self-test is not a
completed measurement, final report, CI result, or owner approval.

Return to the measurement documentation hub in
[`measurement/README.md`](../README.md).
