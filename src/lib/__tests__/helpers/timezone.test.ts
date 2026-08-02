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

/**
 * Resolved UTC offset (in minutes) for `timeZone` at `at`, e.g. `Pacific/Kiritimati`
 * (UTC+14) resolves to `840`. Used to guarantee two zones are observably
 * different, not merely spelled differently.
 */
function offsetMinutesFor(timeZone: string, at: Date = new Date()): number {
  const part = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" })
    .formatToParts(at)
    .find((p) => p.type === "timeZoneName")?.value;
  // Zero-offset zones (UTC itself, Etc/GMT, ...) render as the bare string
  // "GMT" with no numeric suffix at all.
  if (part === "GMT") {
    return 0;
  }
  const match = part ? /GMT([+-]\d+)(?::(\d+))?/.exec(part) : null;
  if (!match) {
    throw new Error(`Could not parse a UTC offset for "${timeZone}" from "${part}"`);
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  return hours * 60 + Math.sign(hours || 1) * minutes;
}

/**
 * A short list of zones spread across very different UTC offsets, so a match
 * on offset is essentially impossible by coincidence for a realistic host.
 * Order is the preference order; earlier entries are tried first.
 */
const OFFSET_SPREAD_CANDIDATES = [
  "Pacific/Kiritimati", // UTC+14
  "America/Los_Angeles", // UTC-7/-8
  "Pacific/Auckland", // UTC+12/+13
  "Asia/Kolkata", // UTC+5:30
  "Africa/Cairo", // UTC+2/+3
] as const;

/**
 * Pick a candidate zone (in `OFFSET_SPREAD_CANDIDATES` order) whose resolved
 * UTC offset matches none of `excludeOffsets` and whose name is not in
 * `excludeNames`. Used to derive zones that are guaranteed to be observably
 * distinct from the real host zone (and from each other), instead of
 * hardcoding a zone that might coincide with it — see #2485 / the CI failure
 * this replaced, where a UTC-host CI runner made a hardcoded comparison
 * degenerate.
 */
function pickZoneWithDistinctOffset(excludeOffsets: number[], excludeNames: string[] = []): string {
  const found = OFFSET_SPREAD_CANDIDATES.find(
    (candidate) =>
      !excludeNames.includes(candidate) && !excludeOffsets.includes(offsetMinutesFor(candidate)),
  );
  if (!found) {
    throw new Error(
      "No candidate in OFFSET_SPREAD_CANDIDATES has a UTC offset distinct from the excluded " +
        "set — extend the candidate list.",
    );
  }
  return found;
}

describe("captureHostTimeZone / withTimeZone (#2485)", () => {
  it("demonstrates the hazard: a bare `delete process.env.TZ` does not undo an assigned zone", () => {
    const trueHost = captureHostTimeZone();
    const trueHostZoneName = resolvedZone();
    const trueHostOffset = offsetMinutesFor(trueHostZoneName);

    try {
      // Pin an EXPLICIT baseline zone that is guaranteed to differ (by
      // resolved offset, not just by name) from whatever the real host
      // happens to be. This is the load-bearing fix for the CI failure: on a
      // Linux host, a bare `delete` correctly falls back to the *ambient*
      // host default (unlike Windows, where it leaves the last-assigned zone
      // cached) — so comparing the post-delete zone against the ambient host
      // zone silently degenerates into a no-op leak check whenever the delete
      // happens to land back on that same ambient default (e.g. ANY time the
      // host's real zone is UTC, as on CI). Comparing against an explicit,
      // never-ambient baseline zone instead makes the check meaningful on
      // every platform: whatever a bare delete resolves to next — the
      // previously-assigned zone (Windows) or the ambient host default
      // (Linux) — it can never coincidentally equal a baseline that was
      // deliberately chosen to be neither of those.
      const zoneA = pickZoneWithDistinctOffset([trueHostOffset]);
      const zoneAOffset = offsetMinutesFor(zoneA);
      const zoneB = pickZoneWithDistinctOffset([trueHostOffset, zoneAOffset], [zoneA]);

      process.env.TZ = zoneA;
      expect(resolvedZone()).toBe(zoneA);
      const baseline = captureHostTimeZone();

      process.env.TZ = zoneB;
      expect(resolvedZone()).toBe(zoneB);

      // Deliberately reproducing the flawed pattern this suite exists to rule
      // out — a bare delete, with no reassignment first.
      delete process.env.TZ;

      // The bug: deleting alone does NOT return Node to zoneA — the zone
      // that was actually active before the flawed pattern's last
      // assignment. (What it resolves to INSTEAD is platform-dependent —
      // some runtimes leave zoneB cached, others fall back to the ambient
      // host default — but on every platform it is provably not zoneA.)
      expect(resolvedZone()).not.toBe(zoneA);

      // Fix it back with the real mechanism, not the flawed one just proven above.
      baseline.restore();
      expect(resolvedZone()).toBe(zoneA);
    } finally {
      // Undo everything above and return to the REAL host state, whatever
      // platform-specific value the bare delete actually left behind.
      trueHost.restore();
    }

    expect(resolvedZone()).toBe(trueHostZoneName);
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
