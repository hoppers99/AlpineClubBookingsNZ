// The frozen test clock, installed before anything else in the test run.
//
// This is a SEPARATE setup file, listed FIRST in `vitest.config.ts`, and that
// ordering is the whole point. ES module imports are hoisted and evaluated
// before any statement in a module's body, so a freeze installed inside
// `vitest.setup.ts` cannot be in place before `vitest.setup.ts`'s own imports
// have run. Vitest evaluates setup files in order, so putting the install in its
// own file guarantees the clock is frozen before ANY other module — setup,
// test file, or anything either of them imports — is evaluated.
//
// That ordering has already mattered once. The first cut of this work installed
// the freeze in a root `beforeAll`, which runs only after every module in the
// file's graph has been evaluated, so module-level date constants still captured
// the real clock: `src/components/admin-sidebar.tsx:123` builds its
// unpaid-finished-stays deep link from today's date at import time, and the
// sidebar test then failed comparing it against a frozen "today".
//
// Why any of this exists, which instant, and how to opt out:
// `src/lib/__tests__/helpers/clock.ts` and `docs/TESTING.md`.
import { afterAll, beforeEach } from "vitest";
import {
  ensureFrozenTestClock,
  installFrozenTestClock,
  restoreRealTestClock,
} from "@/lib/__tests__/helpers/clock";

installFrozenTestClock();

// Re-freeze before each test, but ONLY when the clock has been handed back to
// the real calendar — a suite that deliberately pinned another instant still has
// fake timers installed and is left completely alone. Dozens of suites call
// `vi.useRealTimers()` in an `afterEach` to undo their own pin; the ones whose
// later describes have no clock hooks then run on the real calendar, straight
// back out of the freeze. The rollover canary caught two doing exactly that.
//
// Registered first, so it runs before the file's own `beforeEach` and a per-test
// pin still wins.
beforeEach(() => {
  ensureFrozenTestClock();
});

afterAll(() => {
  restoreRealTestClock();
});
