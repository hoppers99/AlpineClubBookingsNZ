import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import {
  CLUB_TIME_ZONE_FALLBACK,
  readEnvironmentClubTimeZoneSeed,
} from "@/lib/club-time-zone";

/**
 * The two readings of the environment's timezone must not drift apart while both
 * exist (CT-1, #2989; epic #2988).
 *
 * For the length of this epic there are two of them. `APP_TIME_ZONE` in
 * `src/config/operational.ts` is the OLD one — the transitional bridge that every
 * call site CT-2 and CT-4 have not yet migrated still reads. The new one is
 * `readEnvironmentClubTimeZoneSeed()`, which exists only to SEED the persisted
 * club timezone once. **`APP_TIME_ZONE` is retired by CT-6**, and this file
 * retires with it.
 *
 * Until then they must read the same two variables in the same order, because
 * they are two descriptions of the same fact: "the zone this deployment is
 * currently effectively using". If one of them gained a variable the other did
 * not, an upgrade would persist a zone different from the one the un-migrated
 * call sites were still formatting with, and half the app would silently disagree
 * with the other half about what day it is.
 *
 * The pin below is total rather than illustrative:
 *
 *     (readEnvironmentClubTimeZoneSeed() ?? CLUB_TIME_ZONE_FALLBACK) === APP_TIME_ZONE
 *
 * for every combination of the two variables — set, unset, blank, and both at
 * once. Note it pins the RAW strings, not the validated answers: the club
 * timezone additionally refuses `NZT`-style values (that is CT-1's whole point,
 * and `club-time-zone.test.ts` covers it), whereas `APP_TIME_ZONE` will happily
 * carry one. What is pinned here is which variables are read and in what order.
 *
 * STATED LIMIT: this is a behavioural pin over the two names as they are read
 * today. It cannot see a THIRD variable added to only one of the two readings
 * unless that variable is one of these; nothing enumerates the unknown.
 */

const hostTimeZone = captureHostTimeZone();
const originalNextPublicTz = process.env.NEXT_PUBLIC_TZ;

/** `APP_TIME_ZONE` is computed at import, so it needs a fresh module each time. */
async function readAppTimeZone(): Promise<string> {
  vi.resetModules();
  const operational = await import("@/config/operational");
  return operational.APP_TIME_ZONE;
}

function setEnvironment(tz: string | null, nextPublicTz: string | null): void {
  if (tz === null) {
    // Assign before deleting: an assignment is what invalidates Node's cached
    // zone (#2485). `hostTimeZone.restore()` puts the original back the same way.
    process.env.TZ = CLUB_TIME_ZONE_FALLBACK;
    delete process.env.TZ;
  } else {
    process.env.TZ = tz;
  }
  if (nextPublicTz === null) {
    delete process.env.NEXT_PUBLIC_TZ;
  } else {
    process.env.NEXT_PUBLIC_TZ = nextPublicTz;
  }
}

afterEach(() => {
  hostTimeZone.restore();
  if (originalNextPublicTz === undefined) {
    delete process.env.NEXT_PUBLIC_TZ;
  } else {
    process.env.NEXT_PUBLIC_TZ = originalNextPublicTz;
  }
});

afterAll(() => {
  vi.resetModules();
});

describe("the club-timezone seed and the transitional APP_TIME_ZONE read the same environment", () => {
  it.each([
    ["TZ alone", "America/Denver", null, "America/Denver"],
    ["NEXT_PUBLIC_TZ alone", null, "Europe/London", "Europe/London"],
    ["TZ wins over NEXT_PUBLIC_TZ", "America/Denver", "Europe/London", "America/Denver"],
    ["neither set", null, null, CLUB_TIME_ZONE_FALLBACK],
    ["a blank TZ falls through to NEXT_PUBLIC_TZ", "   ", "Europe/London", "Europe/London"],
    ["both blank fall through to the default", "   ", "  ", CLUB_TIME_ZONE_FALLBACK],
    ["surrounding whitespace is trimmed by both", "  America/Denver  ", null, "America/Denver"],
    ["an unusable value is still read by both", "NZT", null, "NZT"],
  ])(
    "agrees with %s",
    async (_label, tz, nextPublicTz, expected) => {
      setEnvironment(tz, nextPublicTz);

      const seed = readEnvironmentClubTimeZoneSeed();
      const appTimeZone = await readAppTimeZone();

      expect(appTimeZone).toBe(expected);
      expect(seed ?? CLUB_TIME_ZONE_FALLBACK).toBe(appTimeZone);
    },
  );

  it("shares the same hard-coded New Zealand default", async () => {
    // If one of the two ever changed its last-resort default, an install with no
    // TZ at all would persist one zone and format with another.
    setEnvironment(null, null);

    expect(readEnvironmentClubTimeZoneSeed()).toBeNull();
    await expect(readAppTimeZone()).resolves.toBe(CLUB_TIME_ZONE_FALLBACK);
    expect(CLUB_TIME_ZONE_FALLBACK).toBe("Pacific/Auckland");
  });
});
