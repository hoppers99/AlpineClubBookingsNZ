import { describe, expect, it } from "vitest";

import {
  frozenClockOptOutReason,
  frozenTestNow,
  optOutOfFrozenClock,
} from "@/lib/__tests__/helpers/clock";

// The frozen clock's escape hatch, proved end to end (#2481).
//
// Every other test file in the repo runs with "today" pinned. This one does
// not, on purpose: without a file that actually takes the opt-out, the opt-out
// path would be dead code that only looks like it works — and the day a suite
// genuinely needs real time, whoever reaches for it discovers it never ran.
//
// It is deliberately the ONLY entry in the allowlist in frozen-test-clock.test.ts.
// Nothing here depends on what the real date is, only on the fact that a real
// clock advances and a frozen one does not, so this file cannot itself become
// the fifth calendar-rollover breakage.
optOutOfFrozenClock(
  "the opt-out mechanism's own end-to-end proof: it must observe a clock that advances"
);

describe("opting out of the frozen test clock", () => {
  it("records the reason for the file", () => {
    expect(frozenClockOptOutReason()).toBe(
      "the opt-out mechanism's own end-to-end proof: it must observe a clock that advances"
    );
  });

  it("leaves this file on a clock that advances", () => {
    const first = Date.now();
    // Spin on the real monotonic clock; 25ms is far more than Date.now()'s
    // resolution, so a real wall clock must have moved by the end of it.
    const spinUntil = performance.now() + 25;
    while (performance.now() < spinUntil) {
      /* busy wait */
    }

    expect(Date.now()).toBeGreaterThan(first);
  });

  it("is not sitting on the frozen instant", () => {
    // Asserted as an inequality rather than "later than", so this stays true
    // whatever the real date is — including under the rollover canary, which
    // winds the frozen instant forward but cannot touch the real one.
    expect(Date.now()).not.toBe(frozenTestNow().getTime());
  });
});
