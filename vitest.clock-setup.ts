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
import { afterAll } from "vitest";
import {
  installFrozenTestClock,
  restoreRealTestClock,
} from "@/lib/__tests__/helpers/clock";

installFrozenTestClock();

afterAll(() => {
  restoreRealTestClock();
});
