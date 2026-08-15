# Unit Test Harness

**Audience:** Developer, Agent.

How the Vitest unit suite is set up, and the one convention that matters most
when a test involves a date: **every test run has a fixed "today"**.

The Playwright browser suite is a separate thing with its own document —
[`E2E_PLAYWRIGHT.md`](E2E_PLAYWRIGHT.md). The journeys each suite is expected to
cover live in [`END_TO_END_TEST_MATRIX.md`](END_TO_END_TEST_MATRIX.md).

Run it with `npm test` (`vitest run`). It needs `DATABASE_URL` set to any value —
an unreachable dummy is correct and a live seeded database is not — so
`prisma.config.ts` resolves. See [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for
the full local gate.

## Shared setup

`vitest.config.ts` points every test file at two setup files, in order —
`vitest.clock-setup.ts` then `vitest.setup.ts`. Between them they:

- **freeze the clock** — the rest of this page;
- stub `server-only` (a Next.js guard with no meaning in the Node test
  environment) so server-side modules can be imported at all;
- supply fake email-delivery environment values, because
  `src/lib/email-delivery.ts` refuses to build a transport without them
  (nodemailer is mocked, so nothing is ever sent).

## The frozen test clock

Plain English: tests are not allowed to know what today's real date is. Every
test file starts with "today" pinned to **1 July 2026**, and it stays there.

Precisely: `vitest.clock-setup.ts` calls
`vi.useFakeTimers({ toFake: ["Date"] })` and
`vi.setSystemTime(2026-07-01T00:00:00.000Z)` in its own module body, for every
file. The mechanism lives in
[`../src/lib/__tests__/helpers/clock.ts`](../src/lib/__tests__/helpers/clock.ts).

Two details there are load-bearing rather than stylistic:

- **A module body, not a `beforeAll`.** A `beforeAll` runs only after every
  module in the file's import graph has already been evaluated. Module-level date
  constants are real code — `src/components/admin-sidebar.tsx:123` builds its
  unpaid-finished-stays deep link from today's date at import time — and a
  hook-based freeze left those on the real clock while the tests checking them
  saw the frozen one.
- **Its own setup file, listed first.** A module's imports evaluate before its
  body, so an install inside `vitest.setup.ts` would still be too late for
  everything `vitest.setup.ts` imports. Vitest evaluates `setupFiles` in order,
  so a dedicated first file freezes the clock before any other module in the run.

A root `beforeEach` then re-freezes before each test **if and only if** nothing
is currently mocking `Date`. Dozens of suites undo their own pin with
`vi.useRealTimers()` in an `afterEach`; where their later describes have no clock
hooks, those tests used to drop straight back out of the freeze — the rollover
canary caught two doing exactly that. A suite that deliberately pinned another
instant is left completely alone, so this only ever converts "real clock" back to
"frozen clock", never one pin into another.

The check is `vi.getMockedSystemTime() !== null`, not `vi.isFakeTimers()`,
because Vitest has two mocked-`Date` states and only one installs fake timers: a
bare `vi.setSystemTime(...)` called while timers are real mocks `Date` on its own
and leaves `vi.isFakeTimers()` false. Guarding on fake timers overwrote that kind
of pin with the default instant.

And what the re-freeze restores is always the **default** instant, never a
suite's own pin — see rule 4 below.

### Why

Four separate times, CI went red on `main` and on every open pull request at the
same moment because the calendar moved on — issues #2426, #2401, #2443 and
#2479. The shape never varied: a suite fixes a date ("a booking on 2026-08-01",
"a payment link that expires in 48 hours"), the code under test asks the real
clock, and on the day the real date passes the fixture the suite fails. Nothing
is in any diff to blame, so whoever is working that morning burns an hour
proving it is not their fault.

The quieter version is worse. A `expect(res.status).not.toBe(403)` assertion
that starts passing off an unrelated `400 Cannot book in the past` has stopped
testing anything at all, and says nothing while it does so (#2443).

Each of the four fixes pinned one suite after it broke. Freezing once, centrally,
removes the whole class instead.

### Why this instant

`2026-07-01T00:00:00.000Z` is midnight UTC, which is **midday** in
`Pacific/Auckland`. A CI runner in UTC and a club in NZ therefore agree on what
calendar day it is, so no date-only fixture becomes zone-dependent — the property
the #2426/#2401 fixes already relied on. It also sits before every mid-2026
fixture in the repo.

**It never advances.** There is no per-release bump. Forward-looking risk is the
canary's job, below (owner decision, 2 August 2026).

### Only `Date` is faked

`toFake: ["Date"]` fakes `Date` and nothing else. `setTimeout`, `setInterval`,
`queueMicrotask` and `performance.now()` stay real, so awaited promises resolve
normally and elapsed-time measurements still work. Freezing timers as well would
hang half the suite; this is the approach #2479 proved on one suite before it was
generalised.

## Writing a date-bearing test

1. **Write dates relative to 1 July 2026.** A "future" booking is
   `2026-08-01`; a "past" one is `2026-06-01`. They stay future and past for
   good.
2. **Never write a fixture relative to the real clock** — no
   `new Date(Date.now() + 7 * 86_400_000)` to mean "next week" against a
   hard-coded expectation. Under the freeze this is deterministic, but it hides
   which date the test actually means.
3. **Need a different fixed instant? Pin it in the file, do not opt out.** A
   suite's own `vi.setSystemTime(...)` in its own `beforeAll`/`beforeEach` wins,
   because the freeze is already installed by the time any hook runs;
   `vitest.config.ts` pins `sequence.hooks: "stack"` so the setup file's
   `afterAll` restore stays last. The `vi.mock("@/lib/date-only", …)` idiom (see
   `site-banners.test.ts`) also still works and is unaffected.

   The worked example is `nz-today-date-only.test.tsx` (#2682), which pins
   `2026-06-30T21:00:00.000Z` — 09:00 on 1 July 2026 in New Zealand, and the
   *previous* UTC day. Its whole subject is that the two disagree, so it also
   shows the two guards a suite like that needs: it asserts up front that the
   UTC day and the club day really are different (a fixture that drifted out of
   the divergence window would otherwise pass vacuously), and it asserts that
   `APP_TIME_ZONE` is still `Pacific/Auckland`, so a contributor doing what rule
   6 below describes gets one clear environment failure instead of five that
   read like product bugs. A suite that keeps the DEFAULT instant but hard-codes
   fixture dates against it should assert that too — `night-occupancy-parity.test.ts`
   (#2681) pins `getTodayDateOnly()` to `2026-07-01` for that reason.

   The club-zone half of that is a shared helper, so every suite says the same
   thing and says it before any date assertion runs:

   ```ts
   import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";

   beforeEach(() => {
     expectClubTimeZonePremise();
     vi.setSystemTime(divergentInstant);
   });
   ```

   Calling it from the `beforeEach` that pins the instant is what makes the
   explanation arrive first: a wrong `TZ` then fails the hook with one sentence
   about the environment, instead of failing every test with a bare
   `expected '2026-06-14' to be '2026-06-15'` that reads like the product bug
   the suite exists to prove fixed (#2834).
4. **Do not hand the clock back to the real calendar.** If your suite pins its
   own instant and wants to undo that, `vi.useRealTimers()` in an `afterEach` is
   safe — the root `beforeEach` re-freezes before the next test — but never rely
   on real time being restored, and never call it expecting later tests in the
   file to see the real date.

   One sharp edge if you do **both**: the re-freeze restores the **default**
   instant, not your pin. A suite that pins once in a `beforeAll` and also hands
   the clock back therefore keeps its instant only until the first handback —
   every test after that silently runs at 1 July 2026. Pin in a `beforeEach`
   instead when your suite does both.
5. **Measuring how long something took? `Date.now()` is no longer a stopwatch.**
   Under the freeze it is a constant, so `Date.now() - before` is always `0` —
   which makes an "it waited long enough" assertion fail and, far worse, makes an
   "it did NOT wait" assertion pass vacuously. Use the shared helper:

   ```ts
   import { realElapsedMs } from "@/lib/__tests__/helpers/clock";

   const before = process.hrtime.bigint();
   await shouldNotHaveWaited();
   expect(realElapsedMs(before)).toBeLessThan(20);
   ```

   `process.hrtime.bigint()` is monotonic, so neither the freeze nor the canary's
   libfaketime shim touches it. `performance.now()` also stays real, but it is
   only safe when **the code under test does not read it too** — otherwise a
   suite that later installs blanket fake timers moves the guard and its test
   together and the assertion passes without anything having waited.
   `member-guest-probe-guard.test.ts` measures its privacy timing floor with
   `process.hrtime.bigint()` for exactly that reason: the guard itself reads
   `performance.now()`, so the test deliberately measures with a different API.
6. **Remember `APP_TIME_ZONE` follows `process.env.TZ`**
   (`src/config/operational.ts:5-8`). Setting `TZ=UTC` to simulate the CI runner
   also moves the *club* zone to UTC, so a timezone bug can silently pass. To
   reproduce a UTC runner with an NZ club, force
   `timeZone = "Pacific/Auckland"` explicitly as well.
7. **Restoring `process.env.TZ` is never a bare `delete` (#2485).** Node only
   re-derives its resolved timezone when `process.env.TZ` is *assigned*;
   deleting the variable removes it from the environment but leaves the
   last-assigned zone cached, so a suite that pins a zone and deletes it on the
   way out leaks that zone into whichever suite the runner schedules next in
   the same worker. Use the shared helper instead of ad-hoc save/restore code:

   ```ts
   import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";

   const hostTimeZone = captureHostTimeZone();

   afterEach(() => {
     hostTimeZone.restore();
   });
   ```

   For a single pinned call, `withTimeZone`/`withTimeZoneAsync` (same module)
   wrap the capture-set-run-restore sequence. `captureHostTimeZone()` must run
   BEFORE anything in the file assigns `process.env.TZ` — module top level, or
   the top of a `describe` block, both of which run before any hook or test
   body. See `src/lib/__tests__/helpers/timezone.ts` for the full mechanism and
   `src/lib/__tests__/helpers/timezone.test.ts` for a proof the leak is real
   and that the helper closes it.

## Opting a file out

A file that genuinely needs the real wall clock calls the shared helper once at
module top level, with a reason:

```ts
import { optOutOfFrozenClock } from "@/lib/__tests__/helpers/clock";

optOutOfFrozenClock("measures real elapsed time across the retry backoff");
```

The call hands the real clock back on the spot. One honest limitation: ES module
imports are hoisted, so the file's own imports still evaluate under the freeze —
if a module-level constant in your import graph must see the real clock, read it
inside a test instead.

The reason is required — an empty one throws — and the file must also be added
to the allowlist in
[`../src/lib/__tests__/frozen-test-clock.test.ts`](../src/lib/__tests__/frozen-test-clock.test.ts),
which pins both the exact list of opted-out files and their count. That contract
test is what keeps the opt-out honest: widening it is always a deliberate diff a
reviewer sees, never a quiet default. It scans **every** module under the
collected roots, not only files named `*.test.ts` — the opt-out's effect is
module state, so a call in a shared helper would otherwise switch the freeze off
for every suite importing it without appearing in the allowlist at all.

Before adding one, check that you actually need the **real** date rather than a
**different** one — case 3 above needs no opt-out at all. A file that mixes
real-time and frozen-time tests gets split into two files rather than opted out
wholesale.

`frozen-test-clock-opt-out.test.ts` is the one standing entry: it exists so the
opt-out path is itself exercised, and asserts only that its clock advances —
never what the date is.

## The rollover canary

The freeze is not airtight by construction: a file can opt out, and code can
reach a date through a path the freeze does not cover. So
`.github/workflows/clock-rollover-canary.yml` re-runs the whole unit suite with
the machine's **real** clock wound forward by **a day, a month and a year**, as
three parallel matrix jobs, and **fails when the suite fails** under the shifted
clock (after `--retry=2`).

Two limits worth knowing. It does not compare results against a baseline run, so
a test that changes fail→pass is not reported; and the retry, which exists to
absorb libfaketime's slowdown, means only a repeatable failure is reported — a
date dependence that surfaces on one ordering in three can be retried green. A
test that really reaches the real calendar fails on every attempt, because the
clock is shifted for the whole run, so the retry does not soften that signal.

The acceptance criterion in plain English: winding the real system clock forward
by a year must not break the suite. A properly frozen test cannot notice the
canary at all — it still sees 1 July 2026. What notices is anything that escaped
the freeze, which is exactly the population that will go red on its own one day.

The shift uses [libfaketime](https://github.com/wolfcw/libfaketime) rather than
setting the runner's system clock: no VM-wide side effects, no fight with NTP
resync, and `FAKETIME_DONT_FAKE_MONOTONIC=1` leaves monotonic clocks real so
timers, awaited promises and `performance.now()` behave normally. A dedicated
step proves the shift actually reaches Node's `Date` before the suite runs,
because a canary whose clock shift silently failed would report green while
checking nothing.

- It runs on **pushes to `main`** and on a **nightly schedule** (14:00 UTC =
  02:00 NZST), plus manual `workflow_dispatch`.
- It **fails loudly** there, and writes a job summary explaining that the
  triggering commit is almost certainly not the cause.
- It is **never a pull-request check** (owner decision, 2 August 2026). The
  workflow has no `pull_request` trigger, so it cannot become a required check
  and cannot block unrelated work on a problem that is, by construction, not
  urgent yet.

A red canary means some test still reaches the real calendar. Fix the test so it
reads the frozen clock; do not opt the file out.

Reproduce a canary job locally on Linux:

```bash
sudo apt-get install -y faketime
# -f is required: without it the offset is parsed by `date -d`, which rejects it.
# The raised timeouts and the retry are the libfaketime tax — every clock call
# and every subprocess spawn goes through the LD_PRELOAD shim. A test that really
# reaches the real calendar fails on every retry, so this does not soften the
# signal; only a slowness flake passes.
FAKETIME_DONT_FAKE_MONOTONIC=1 faketime -f '+366d' \
  npm test -- --testTimeout=30000 --hookTimeout=30000 --retry=2
```

### Moving the frozen instant locally

Separately from the canary, two environment variables move the **frozen** instant
itself. They are a local diagnostic — the canary does not use them, because
moving the frozen date tests something else entirely (whether fixtures survive a
different "today") and would fail suites that are perfectly correct.

| Variable | Meaning |
| --- | --- |
| `TEST_CLOCK_OFFSET_DAYS` | Whole days added to the frozen instant. May be negative. |
| `TEST_CLOCK_ISO` | An absolute ISO-8601 instant replacing the frozen one entirely. |

```bash
# Reproduce a specific rollover — this is the date #2443 predicted would break
# the two subscription-gate suites, and it does.
TEST_CLOCK_ISO=2026-12-02T00:00:00.000Z npx vitest run \
  src/lib/__tests__/phase2-guest-subscription.test.ts
```

A malformed value fails the run rather than falling back to the frozen instant —
falling back would report green while checking something other than what you
asked for, which is the same vacuous-pass failure this whole convention exists to
prevent.

## Asserting that a recovery alert holds focus

The other convention that is load-bearing rather than stylistic, for the same
reason as the frozen clock: written the obvious way, the assertion reports green
or red on something other than what it claims to check.

Eighteen admin and member surfaces render a **permanently mounted** `role="alert"`
that a failed action populates and then takes focus, so a keyboard or
screen-reader user is not left on a control that has just been re-enabled while
the explanation appears elsewhere on the page. Sixteen use
`src/components/focused-action-error.tsx`; `policy-exception-requests-panel.tsx`
and `roster-editor.tsx` inline their own copy.

Assert that contract with the shared helper, never by hand:

```ts
import { expectRecoveryAlertToHoldFocus } from "@/lib/__tests__/helpers/focus";

fireEvent.click(screen.getByRole("button", { name: "Confirm Booking" }));
await waitFor(() => expect(alert).toHaveTextContent(RETRY_MESSAGE));
await expectRecoveryAlertToHoldFocus(alert);
```

### Why not by hand

Both obvious spellings are wrong, and this repository shipped both before #2635.

**A synchronous `expect(document.activeElement).toBe(alert)`** taken straight
after a `waitFor` on the alert's text passes only by luck. The component focuses
in a passive effect, which React flushes in a Scheduler task *after* the commit
that puts the message in the DOM. Measured on this stack: at the
mutation-observer checkpoint where `waitFor`'s callback first succeeds, focus had
landed in **0 of 30 runs**, arriving exactly one event-loop turn later. The
assertion survived only because React Testing Library's `asyncWrapper` happens to
drain one `setTimeout(0)` before handing control back — a one-turn margin inside
a library internal that nothing guarantees. A loaded CI runner is enough to lose
it, and `main` went intermittently red on a commit that passed on a rerun of the
identical SHA.

**A bare `await waitFor(() => expect(document.activeElement).toBe(alert))`** is
not the fix either. `waitFor` resolves on the first poll where the condition
holds, so focus that lands and is then stolen by a later commit passes it — a
weaker guarantee than the one being claimed. #2618 relaxed the member-facing
waitlist card to this spelling to dodge the race above, and an earlier review
recorded that as a finding rather than a fix.

`expectRecoveryAlertToHoldFocus` asserts both halves: it waits for focus to
arrive, then settles every pending render and effect and re-asserts
synchronously. So it depends on no ordering between React's flush and the test
runner's drain, and it fails if the focus does not stay.

### The related trap: `findByRole("alert")` on a permanently mounted alert

Because the live region is mounted **empty** from the start,
`await screen.findByRole("alert")` matches it immediately and waits for nothing.
Any text assertion on the next line inherits the same one-turn margin. Wait for
the text, not the element:

```ts
const alert = await screen.findByRole("alert");
await waitFor(() => expect(alert).toHaveTextContent("Payment Error"));
```

### Do not make the component's effect a layout effect

It looks like the tidy fix — focus in the same commit as the message, no window
at all — and it regresses the surfaces that raise their failure from inside a
closing dialog, to exactly the outcome the component exists to prevent. Radix's
focus scope traps focus inside an open dialog and releases it from a *passive*
effect cleanup, restoring focus to whatever was focused when the dialog opened.
Those surfaces batch "close the dialog" and "record the failure" into one commit,
so a layout effect focuses the alert while the closing dialog's content is still
mounted: the trap steals it back and the release then hands focus to the control
that opened the dialog — or to `<body>` under a synthetic click, which does not
focus its button. `focused-action-error-focus-contract.test.tsx` pins this
deliberately; so, incidentally, does `deletion-requests-client.test.tsx`.

## A mutation probe is a change you have to undo

`AGENTS.md` requires every new guard to be mutation-verified: break the thing
the guard exists to catch, confirm the suite goes red, **then restore the
mutation and re-run**. The restore is the half that gets skipped, and a probe
left in the tree is a shipped defect wearing a green suite — the suite is green
precisely because the guard is still working on code you no longer meant to
ship.

Two traps make the restore less reliable than it looks:

- **Check the restore against the repository, not against your own backup.**
  `git diff` before committing is the only check that cannot agree with itself.
  A hash comparison against a copy you made is satisfied by a probe that never
  landed at all, which is the same vacuous pass the frozen-clock section is
  about.
- **On Windows, prove the probe landed where you think.** .NET's working
  directory is not PowerShell's: `[IO.File]::ReadAllText("AGENTS.md")` after a
  `Set-Location` into a worktree reads and writes the file of the **original**
  directory, so a probe run from a worktree can silently mutate — or, worse,
  no-op against — a different checkout. Use absolute paths, and assert the
  mutated text actually differs before you run the suite.

## A shell-out suite fails on Windows for a reason that is not load

Four suites prove a real `bash` gate by running it against a throwaway fixture:
`review-findings-contracts.test.ts`, `blue-green-ledger-lint.test.ts`,
`data-migration-verification-gate.test.ts` and
`adult-member-hosting-coverage-migration.test.ts`.

For a long time this section said the first of those was **load-sensitive** and
told you to re-run it alone. That was wrong, and it is worth knowing why,
because a wrong diagnosis that suggests an action is more expensive than no
diagnosis at all: three separate lanes in one session each re-established that
the red suite was not theirs, and each threw the reasoning away. Re-running can
never help, because load was never involved.

The measured cause (#2886) is that on Windows `bash` is
`C:\Windows\System32\bash.exe` — **WSL**, not Git Bash — and two things then
fail deterministically, on a clean tree, with the suite run alone:

1. A drive-letter fixture path does not exist inside WSL's filesystem
   namespace, so the gate reported `Migration SQL file not found: C:/Users/…`.
   Flipping the separators does not help; only a path **relative to the `cwd`
   the script is spawned with** resolves under both WSL and Git Bash.
2. Variables put on `spawnSync`'s `env` option do not cross into WSL at all.
   The gate saw them unset and fell back to its production defaults — so a test
   pointing the validator at a fixture ledger was silently running it against
   the repository's real `docs/BLUE_GREEN_MIGRATION_SAFETY.tsv`. That one failed
   without any error message, which is the more dangerous of the two.

Both are fixed centrally in `src/lib/__tests__/helpers/bash-fixture-path.ts`,
which carries the measurements. **Use `bashFixturePath` and `bashGateArgs` for
any new shell-out**; on Linux and CI they are equivalent to what these suites
did before, which was checked by running both invocation shapes over the same
fixtures inside `node:24-bookworm` and comparing status, stdout and stderr.

Two things this does *not* cover, so that the list stays honest:

- A test that spawns a POSIX tool **directly** rather than through `bash` still
  needs that tool on PATH. The awk/TypeScript splitter-agreement case in
  `data-migration-verification-gate.test.ts` spawns `awk`, Windows ships none,
  and `spawnSync` reports `status: null` — which quietly satisfies a
  `not.toBe(0)` assertion. That case now skips on Windows when `awk` is absent
  and stays mandatory everywhere it can run, including CI.
- These suites do carry generous **inline** per-test timeouts, written as the
  third argument to each `it(...)`, and an inline timeout does win over
  `--testTimeout`. That is a real fact about editing them
  (`./helpers/migration-gate-timeouts.ts` holds the budgets and the reasoning) —
  it was simply never the reason they were failing.

## Census tests and the merge hazard

A third convention that is load-bearing rather than stylistic, for the same
reason as the two above: written the obvious way, this reports green on
something other than what it claims.

A **census** is a test that pins how many call sites of a given shape exist —
every writer that can strand a booking, every `toLocaleDateString` escape, every
`ViewOnlyActionButton` opt-out. It is one of the strongest guards here, because
it fails the moment somebody adds a call site nobody classified.

It also carries a merge hazard no CI check can see. Two branches each add one
call site. Each bumps the census literal from `6` to `7` — the same line, the
same value — so git merges them with **no conflict**. Both were green alone, the
merged suite is green, and `main` now asserts `7` where the truth is `8`. The
next real addition sails through a census that has stopped counting anything.

So:

1. **Re-derive the count; never increment it.** Run the census against the tree
   in front of you and record what it reports. Never take the number you started
   with and add your own branch's additions to it.
2. **Re-derive it after every merge into your branch, and once more before
   flipping the PR ready.** Those are the only moments the merged tree exists.
3. **If the number moved for a reason you did not cause, the hazard has fired**
   — check the other branch's entries too. A wrong total usually means a wrong
   *classification*, not just arithmetic: something named that is not really a
   member of the set, or a real one missing. Commit `5a5e4e748` (#2649) found a
   census claiming "at least nine other producers" that was really six, with two
   of the named ones refuted outright.
4. **Prefer a census that enumerates over one that only counts.** Listing the
   entries by name puts two concurrent additions on the same lines, so git
   raises a conflict and a human classifies both — which is exactly the review a
   bare integer skipped.
