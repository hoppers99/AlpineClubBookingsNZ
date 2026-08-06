# Phase 2: paired baseline/current timing evidence (#2352 slice 1)

Audience: developer / agent

This harness produces relative Windows/WSL evidence for the already-reviewed
slice-1 implementation. It does not decide whether work progresses. Every
completed aggregate remains `OWNER_REVIEW_REQUIRED`; fewer than four valid,
evenly counterbalanced pairs remains `PRELIMINARY_ONLY`. Four is the harness's
integrity choice for a balanced C-B/B-C final run; it is stricter than the
owner's verbatim minimum of three.

## Owner thresholds (verbatim)

- At least three contemporaneous current/baseline pairs are required.
- Preferred CPU reduction is at least 80%; below roughly 50% is the explicit stop condition; 50-80% requires owner review.
- Current warm cached median and p95 should be approximately 300 ms or below, with repeatable improvement, stable idle recovery and no unacceptable churn/memory/regeneration load.
- Windows/WSL results support relative comparison only, not exact Tokoroa capacity.

The word "approximately" is intentionally qualitative. The reporter records
median and p95 but applies no invented autonomous p95 gate. Correctness and
security must pass independently before timing; any failure stops progression.

## Safety and prerequisites

- Use only the isolated `tacbookings-measure` Compose project and its loopback
  ports. Never use production/staging credentials, databases, backups, or live
  providers.
- Do not copy `.env.measure` or any raw `results/` directory into a patch or PR.
- The host must be quiet. Close build lanes, browser/E2E work, and heavy apps.
  `run-pair.sh` requires `QUIET_HOST_ATTESTED=YES`, captures Windows process/CPU
  and Docker evidence before/between/after sides, and fails if an unexpected
  running container or excessive sampled host CPU is present. The recorded
  limit is a contamination control, not a product-performance threshold.
- Build both images from immutable source archives, set
  `org.opencontainers.image.revision` to the exact source commit, and retain the
  archives. Do not identify an image by a mutable tag alone.
- Complete the exact correctness/security run for each image first. Retain each
  machine-readable report; the manifest must record `result: "passed"` and its
  SHA-256. A failed/pending report cannot enter timing.

## One-time canonical database preparation

Prepare the sanctioned isolated dataset, then create one immutable custom dump.
The dump path must not already exist; the helper refuses to overwrite it.

```bash
cd C:/Users/jorda/Local_Repos/wt-measure
bash measurement/stack/measure-stack.sh prepare
bash measurement/stack/measure-stack.sh create-canonical-dump \
  C:/Users/jorda/AppData/Local/Temp/issue-2352/canonical.dump
```

Record the printed archive SHA-256. Each side is restored from that exact dump,
then the complete logical database is fingerprinted before and after timing.
Any drift aborts the pair. The runner also records the app's redacted database
target, DNS result, Postgres identity, container/network identity, and the full
uninterpolated Compose/resource definition so the restored database and the app
connection cannot be confused with another stack.

## Bind correctness, sources, images, and expected responses

Copy `correctness-manifest.example.json` outside the repository results tree and
replace every placeholder. For both sides it binds:

- immutable Docker image ID and exact OCI revision;
- source archive path and SHA-256;
- correctness report path, SHA-256, and explicit passed result;
- canonical database archive path and SHA-256;
- exact body SHA-256 and ETag for current `/about`, plus expected
  `X-Nextjs-Cache` classification for every route. Dynamic routes deliberately
  bind `body_sha256` and `etag` to `null`: per-request CSP nonces make their raw
  bodies unstable, while the exact correctness-report checksum binds their
  already-completed content/security proof.

Expected bodies/ETags come from the completed correctness run, never from the
first timed request. Current `/about` must be `HIT`; baseline `/about` and all
three controls must have no `X-Nextjs-Cache` header (the intended dynamic
classification). `verify-binding.mjs` compares the manifest to the image,
archives, and report before any samples. `verify-http-proof.mjs` checks exact
status/body/ETag/classification immediately before and after every CPU block.

## Exact run order

Run one complete orchestrated set in a quiet-host session. The owner's minimum
is three contemporaneous pairs; this wrapper deliberately runs four so C-B and
B-C each repeat twice, with no order imbalance:

1. current then baseline;
2. baseline then current;
3. current then baseline;
4. baseline then current.

Do not call `run-phase2.sh` or `run-pair.sh` directly for decision evidence.

```bash
cd C:/Users/jorda/Local_Repos/wt-measure
export QUIET_HOST_ATTESTED=YES

bash measurement/phase2/bin/orchestrate-pairs.sh \
  --manifest C:/Users/jorda/AppData/Local/Temp/issue-2352/correctness-manifest.json \
  --output-id post2591-final
```

The wrapper snapshots and checksums the manifest and every referenced immutable
input, acquires a single-flight lock, continuously monitors host contamination,
assigns collision-proof pair IDs and absolute output roots, enforces inter-side
and inter-pair gaps, validates every sealed pair, and writes its set-level
completion marker only after all four return successfully. `--output-id` must
be new; never reuse a partial output directory.

For a controlled non-default database integration, the supported injection
boundary is `--restore-hook <executable>` and
`--fingerprint-hook <executable>`: restore receives
`<archive-path> <sha256> <side>`, fingerprint receives `<side>` and prints one
lowercase SHA-256. Without hooks, the isolated stack helpers are used. The pair
runner receives only the frozen manifest, exact side images/archive/checksum,
explicit new output root, and hook contract. The side runner independently
proves the launched container image ID and after-fingerprint.

The default maximum gaps between sides and between pairs are 600 seconds. A
restore or interruption that exceeds either invalidates the set rather than
silently weakening contemporaneity. Exact start/end/gap timestamps are in each
`pair.json` and the orchestration events. Do not loosen them during a run; use a
fresh output ID after any interrupted attempt.

Each side performs, in order:

1. immutable binding and complete environment/service/resource capture;
2. cold-start observations;
3. per-route warm-up, exact pre-proof, sequential CPU/timing block, exact
   post-proof;
4. isolated idle cycles, each less than 300 seconds, preserving the first
   request and its cgroup CPU separately from four follow-ups;
5. a separate 300+ second revalidation segment (never pooled with idle);
6. bounded concurrency with a real request timeout, monotonic actual elapsed
   RPS, status counts, and classified errors;
7. database after-fingerprint, summary, output checksums, and durable
   `COMPLETED.json` marker.

Every timed segment has UTC boundary markers, cgroup CPU/memory/throttling/OOM
snapshots, 1-second Docker CPU/memory/PID/I/O samples, restart counts, and
segment-scoped application logs. A restart or OOM aborts summarisation. Log
noise, throttling, memory, and regeneration load remain owner-reviewed evidence.

Tunables are `RUNS=200`, `WARMUP=20`, `COLD_RUNS=5`, `IDLE_CYCLES=3`,
`IDLE_SECONDS=120`, `REVALIDATION_SECONDS=305`, `CONC=10`, `DURATION=30`,
and `REQUEST_TIMEOUT_SECONDS=10`. `IDLE_SECONDS >= 300` and
`REVALIDATION_SECONDS < 300` fail closed.

## Aggregate without changing raw evidence

Point the aggregator at the completed, sealed orchestration output. It derives
the four pair directories from the checksummed set record; do not hand-select a
subset:

```bash
node measurement/phase2/bin/aggregate-pairs.mjs \
  --orchestration measurement/phase2/results/orchestration-post2591-final \
  --label "#2352 post-#2591 four-pair evidence" \
  --out-prefix C:/Users/jorda/AppData/Local/Temp/issue-2352/phase2-aggregate
```

Aggregation verifies every nested checksum/completion marker, unique pair ID,
at least four pairs with equal C-B/B-C counts, timestamp/gap, common correctness/database binding, before/
after database equality, response proof, sample count, restart/OOM status, and
load errors. It reports paired reductions, repeatability, relative latency,
idle/revalidation, control drift, cache proof, memory/throttling/restart/log
evidence, and concurrency. Those qualitative dimensions are explicitly
`OWNER_REVIEW_REQUIRED`; output never says a progression gate autonomously
passed.

## Dependency-free refutation tests

No install is required:

```bash
node measurement/phase2/bin/self-test.mjs
bash -n measurement/phase2/bin/run-phase2.sh
bash -n measurement/stack/measure-stack.sh
```

The fixtures exercise wrong cache classification, mutated response body,
incorrect checksums, incomplete output, and non-monotonic/errorful load evidence.
They contain no credentials or measurement results.

## Cleanup and reporting

Leave the isolated stack down while retaining its volume and images:

```bash
bash measurement/stack/measure-stack.sh down
```

Report the generated evidence as preliminary/relative until the owner reviews
all qualitative dimensions. A later Tokoroa confirmation still checks warm
response time, container CPU/cache operation, immediate invalidation, CSP, and
proxy/filesystem behavior; Windows/WSL results are not Tokoroa capacity.
