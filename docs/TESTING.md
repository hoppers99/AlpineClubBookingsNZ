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

`vitest.config.ts` points every test file at `vitest.setup.ts`, which:

- stubs `server-only` (a Next.js guard with no meaning in the Node test
  environment) so server-side modules can be imported at all;
- supplies fake email-delivery environment values, because
  `src/lib/email-delivery.ts` refuses to build a transport without them
  (nodemailer is mocked, so nothing is ever sent);
- **freezes the clock** — the rest of this page.

## The frozen test clock

Plain English: tests are not allowed to know what today's real date is. Every
test file starts with "today" pinned to **1 July 2026**, and it stays there.

Precisely: `vitest.setup.ts` calls
`vi.useFakeTimers({ toFake: ["Date"] })` and
`vi.setSystemTime(2026-07-01T00:00:00.000Z)` in its own module body, for every
file. The mechanism lives in
[`../src/lib/__tests__/helpers/clock.ts`](../src/lib/__tests__/helpers/clock.ts).

The module body, not a `beforeAll`, is load-bearing. Setup files evaluate before
the test file is imported, whereas a `beforeAll` runs only after every module in
the file's import graph has already been evaluated. Module-level date constants
are real code — `src/components/admin-sidebar.tsx:123` builds its
unpaid-finished-stays deep link from today's date at import time — and a
hook-based freeze left those on the real clock while the tests checking them saw
the frozen one.

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
4. **Measuring how long something took? `Date.now()` is no longer a stopwatch.**
   Under the freeze it is a constant, so `Date.now() - before` is always `0` —
   which makes an "it waited long enough" assertion fail and, far worse, makes an
   "it did NOT wait" assertion pass vacuously. Use `process.hrtime.bigint()`
   (or `performance.now()`); both stay real, and both are what
   `member-guest-probe-guard.test.ts` uses for the privacy timing floor.
5. **Remember `APP_TIME_ZONE` follows `process.env.TZ`**
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
"today" wound forward by **1 day, 1 month (30 days) and 1 year (365 days)** as
three parallel matrix jobs.

- It runs on **pushes to `main`** and on a **nightly schedule** (14:00 UTC =
  02:00 NZST), plus manual `workflow_dispatch`.
- It **fails loudly** there, and writes a job summary explaining that the
  triggering commit is almost certainly not the cause.
- It is **never a pull-request check** (owner decision, 2 August 2026). The
  workflow has no `pull_request` trigger, so it cannot become a required check
  and cannot block unrelated work on a problem that is, by construction, not
  urgent yet.

A red canary means some test still depends on the calendar and will go red on its
own one day, taking `main` and every open PR with it. Fix the fixture; do not
opt the file out.

### Winding the clock locally

Two environment variables, read by `src/lib/__tests__/helpers/clock.ts`:

| Variable | Meaning |
| --- | --- |
| `TEST_CLOCK_OFFSET_DAYS` | Whole days added to the frozen instant. May be negative. What the canary sets. |
| `TEST_CLOCK_ISO` | An absolute ISO-8601 instant replacing the frozen one entirely. |

```bash
# Reproduce a canary job.
TEST_CLOCK_OFFSET_DAYS=365 npm test

# Reproduce a specific rollover — this is the date #2443 predicted would break
# the two subscription-gate suites.
TEST_CLOCK_ISO=2026-12-02T00:00:00.000Z npx vitest run \
  src/lib/__tests__/phase2-guest-subscription.test.ts
```

A malformed value fails the run rather than falling back to the frozen instant —
a canary that quietly tested the default clock would report green while checking
nothing, which is the same vacuous-pass failure this whole convention exists to
prevent.
