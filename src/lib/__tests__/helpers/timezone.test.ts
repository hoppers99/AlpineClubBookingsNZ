import { describe, expect, it } from "vitest";

import {
  captureHostTimeZone,
  withTimeZone,
  withTimeZoneAsync,
} from "@/lib/__tests__/helpers/timezone";

/**
 * #2485 — proves the actual hazard this helper exists to close, and that the
 * helper closes it.
 *
 * Every case here restores `process.env.TZ` to the REAL host state itself
 * (via `captureHostTimeZone` at the top of each test, mirroring the pattern
 * this file teaches everyone else to use) before returning, so this suite
 * cannot itself become another entry on the leak list it is guarding against.
 */

function resolvedZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** A zone name guaranteed to differ from whatever the host is actually on. */
function zoneDifferentFromHost(): string {
  return resolvedZone() === "Pacific/Kiritimati" ? "UTC" : "Pacific/Kiritimati";
}

describe("captureHostTimeZone / withTimeZone (#2485)", () => {
  it("demonstrates the hazard: a bare `delete process.env.TZ` does not undo an assigned zone", () => {
    const hostTimeZone = captureHostTimeZone();
    const hostZoneName = resolvedZone();
    const otherZone = zoneDifferentFromHost();

    try {
      process.env.TZ = otherZone;
      expect(resolvedZone()).toBe(otherZone);

      // Deliberately reproducing the flawed pattern this suite exists to rule
      // out — a bare delete, with no reassignment first.
      delete process.env.TZ;

      // The bug: deleting alone does NOT return Node to the host's real zone.
      expect(resolvedZone()).not.toBe(hostZoneName);
      expect(resolvedZone()).toBe(otherZone);
    } finally {
      // Fix it back with the real mechanism, not the flawed one just proven above.
      hostTimeZone.restore();
    }

    expect(resolvedZone()).toBe(hostZoneName);
  });

  it("restore() returns to the host zone whether process.env.TZ started undefined or defined", () => {
    // Case 1: TZ starts undefined (the common case — no env override at all).
    const originalTz = process.env.TZ;
    // Setting up the "started undefined" precondition for the case below —
    // safe here only because it is immediately re-captured and fully restored
    // at the end of this test.
    delete process.env.TZ;
    const hostZoneName = resolvedZone();

    const undefinedCase = captureHostTimeZone();
    process.env.TZ = zoneDifferentFromHost();
    expect(resolvedZone()).not.toBe(hostZoneName);
    undefinedCase.restore();
    expect(process.env.TZ).toBeUndefined();
    expect(resolvedZone()).toBe(hostZoneName);

    // Case 2: TZ starts defined (a host that pins its own zone explicitly).
    process.env.TZ = "Pacific/Auckland";
    const definedZoneName = resolvedZone();
    const definedCase = captureHostTimeZone();
    process.env.TZ = zoneDifferentFromHost();
    expect(resolvedZone()).not.toBe(definedZoneName);
    definedCase.restore();
    expect(process.env.TZ).toBe("Pacific/Auckland");
    expect(resolvedZone()).toBe(definedZoneName);

    // Put the real environment back exactly as this test found it.
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  it("withTimeZone pins for the duration of run() and restores after", () => {
    const hostZoneName = resolvedZone();
    const pinnedZone = zoneDifferentFromHost();

    const observedInsideRun = withTimeZone(pinnedZone, () => resolvedZone());

    expect(observedInsideRun).toBe(pinnedZone);
    expect(resolvedZone()).toBe(hostZoneName);
  });

  it("withTimeZoneAsync only restores after the awaited work settles, not before", async () => {
    const hostZoneName = resolvedZone();
    const pinnedZone = zoneDifferentFromHost();
    let observedDuringAwait: string | null = null;

    const result = await withTimeZoneAsync(pinnedZone, async () => {
      // Yield a macrotask so a premature restore (firing before this resumes)
      // would be observable here rather than masked by purely synchronous work.
      await new Promise((resolve) => setTimeout(resolve, 0));
      observedDuringAwait = resolvedZone();
      return "done";
    });

    expect(observedDuringAwait).toBe(pinnedZone);
    expect(result).toBe("done");
    expect(resolvedZone()).toBe(hostZoneName);
  });

  it("a combined run of several sequential pins never leaks a zone into the next one (the real regression)", () => {
    const hostZoneName = resolvedZone();
    const zonesInOrder = ["UTC", "Pacific/Auckland", "America/New_York", "Pacific/Kiritimati"];

    for (const zone of zonesInOrder) {
      // Each iteration stands in for one "suite" in a shared worker: pin,
      // assert the pin took effect, restore — and prove the PREVIOUS
      // iteration's zone is not what's still active.
      expect(resolvedZone()).toBe(hostZoneName);
      withTimeZone(zone, () => {
        expect(resolvedZone()).toBe(zone);
      });
      expect(resolvedZone()).toBe(hostZoneName);
    }
  });
});
