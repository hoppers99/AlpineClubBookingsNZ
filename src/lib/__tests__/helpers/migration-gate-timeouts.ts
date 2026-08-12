/**
 * Test budgets for the suites that shell out to the real bash migration-safety
 * gates (#2806).
 *
 * These live in one place because the number needs a reason, and the reason is
 * the same everywhere it is used. Import them rather than writing a literal, so
 * the next person changing one changes them all and reads why first.
 *
 * ## Why these tests need a budget at all
 *
 * They do not assert against a parsed copy of the gate — they run
 * `scripts/validate-blue-green-migrations.sh` and
 * `scripts/check-migration-safety-coverage.sh` for real, against a fixture.
 * That is the point of them: a gate that is only modelled is a gate nobody has
 * proved. The cost is therefore process creation, not computation — each run
 * forks roughly 30 short-lived `grep`/`sed`/`awk` children. There is no
 * repeated work to hoist into a `beforeAll` and nothing worth memoising,
 * because every run executes the gate against a DIFFERENT fixture.
 *
 * ## The measured numbers behind the values below
 *
 * One validator run against a small fixture:
 *
 * | Platform                                   | Per run    |
 * | ------------------------------------------ | ---------- |
 * | Linux (`ubuntu:24.04`, i.e. what CI runs)   | 50-65 ms   |
 * | Windows/MSYS developer machine             | 1400-2500 ms |
 *
 * A ~30x platform gap, and it is entirely fork cost: a fork is ~2 ms on Linux
 * and ~70 ms under MSYS. No amount of test-side work closes it. Running a
 * test's independent validator invocations concurrently instead of one after
 * the other recovers about 3.3x of it on Windows (measured: ten runs, 25.0 s
 * sequential vs 7.6 s concurrent) and costs Linux nothing — that is done, and
 * it is the reason these budgets did not have to go higher still.
 *
 * The whole committed migration tree, via the coverage gate: 2.2 s on Linux,
 * 28.7 s on Windows, 89.9 s on Windows with three agent lanes building at once.
 *
 * ## So these are hang-catchers, not pass marks
 *
 * On CI every one of these tests finishes in well under a second, so a budget
 * here is never the thing that decides a PR — CI timings still show a genuine
 * slowdown plainly. The budget exists so that a Windows developer machine under
 * load does not produce a false red on a migration-safety test, which reads
 * alarmingly (it looks like a schema change broke a gate) and has already cost
 * two investigations. Each value carries roughly 2x headroom over the worst
 * runtime ever measured on the slow platform, and ~100x over CI. If one of
 * these ever burns its full budget on CI, something is genuinely wrong and the
 * test SHOULD fail.
 */

/** A test that runs the migration-safety gate against purpose-built fixtures. */
export const MIGRATION_GATE_TIMEOUT_MS = 60_000;

/** A test that runs a gate across the whole committed migration tree. */
export const MIGRATION_GATE_TREE_TIMEOUT_MS = 240_000;
