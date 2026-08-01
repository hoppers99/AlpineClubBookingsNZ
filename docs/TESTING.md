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

A root `beforeEach` then re-freezes before each test **if and only if** the clock
has been handed back to the real calendar. Dozens of suites undo their own pin
with `vi.useRealTimers()` in an `afterEach`; where their later describes have no
clock hooks, those tests used to drop straight back out of the freeze — the
rollover canary caught two doing exactly that. A suite that deliberately pinned
another instant still has fake timers installed and is left completely alone, so
this only ever converts "real clock" back to "frozen clock", never one pin into
another.

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
4. **Do not hand the clock back to the real calendar.** If your suite pins its
   own instant and wants to undo that, `vi.useRealTimers()` in an `afterEach` is
   safe — the root `beforeEach` re-freezes before the next test — but never rely
   on real time being restored, and never call it expecting later tests in the
   file to see the real date.
5. **Measuring how long something took? `Date.now()` is no longer a stopwatch.**
   Under the freeze it is a constant, so `Date.now() - before` is always `0` —
   which makes an "it waited long enough" assertion fail and, far worse, makes an
   "it did NOT wait" assertion pass vacuously. Use `process.hrtime.bigint()`
   (or `performance.now()`); both stay real, and both are what
   `member-guest-probe-guard.test.ts` uses for the privacy timing floor.
6. **Remember `APP_TIME_ZONE` follows `process.env.TZ`**
   (`src/config/operational.ts:5-8`). Setting `TZ=UTC` to simulate the CI runner
   also moves the *club* zone to UTC, so a timezone bug can silently pass. To
   reproduce a UTC runner with an NZ club, force
   `timeZone = "Pacific/Auckland"` explicitly as well.

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
reviewer sees, never a quiet default.

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
three parallel matrix jobs, and fails if any test result changes.

That is the acceptance criterion stated directly: winding the real system clock
forward by a year must not change any test result. A properly frozen test cannot
notice the canary at all — it still sees 1 July 2026. What notices is anything
that escaped the freeze, which is exactly the population that will go red on its
own one day.

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
