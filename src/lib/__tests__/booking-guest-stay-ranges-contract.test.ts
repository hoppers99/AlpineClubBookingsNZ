/**
 * #2622 source contract for the two stay models.
 *
 * The night model and the operational-day model must stay separate and must
 * each have exactly one definition. These are source-text assertions on
 * purpose: the behaviour they protect is "nobody quietly grew a third model",
 * which no runtime assertion can see.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function source(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function allSourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return allSourceFiles(absolute);
    return /\.(ts|tsx)$/.test(entry.name) ? [absolute] : [];
  });
}

// Byte-for-byte copies of the frozen night-model helpers. `capacity.test.ts`
// pins back-to-back handover behaviour through these, and the pricing,
// whole-lodge and multi-date-range suites are built on them, so #2622 added the
// operational-day rule ALONGSIDE them rather than editing them.
const FROZEN_IS_GUEST_ACTIVE_ON_NIGHT = `export function isGuestActiveOnNight(
  guest: GuestStayRange,
  night: Date,
  booking: BookingStayRange
): boolean {
  const nightKey = dateOnlyKey(night);

  // Explicit night set wins: a guest is active on a night iff that night is in
  // their set. This correctly handles non-contiguous stays (gaps are absences).
  const nightKeySet = getGuestNightKeySet(guest);
  if (nightKeySet) {
    return nightKeySet.has(nightKey);
  }

  // Fallback: contiguous envelope, half-open [stayStart, stayEnd).
  const stayStartKey = dateOnlyKey(getGuestStayStart(guest, booking));
  const stayEndKey = dateOnlyKey(getGuestStayEnd(guest, booking));

  return stayStartKey <= nightKey && nightKey < stayEndKey;
}`;

const FROZEN_GET_ACTIVE_GUESTS_FOR_NIGHT = `export function getActiveGuestsForNight<Guest extends GuestStayRange>(
  guests: Guest[] | null | undefined,
  night: Date,
  booking: BookingStayRange
): Guest[] {
  return (guests ?? []).filter((guest) =>
    isGuestActiveOnNight(guest, night, booking)
  );
}`;

describe("stay-range model contract (#2622)", () => {
  const stayRanges = source("src/lib/booking-guest-stay-ranges.ts");

  it("keeps the night-model helpers byte-identical", () => {
    expect(stayRanges).toContain(FROZEN_IS_GUEST_ACTIVE_ON_NIGHT);
    expect(stayRanges).toContain(FROZEN_GET_ACTIVE_GUESTS_FOR_NIGHT);
  });

  it("defines the operational-day rule exactly once", () => {
    for (const named of [
      "export function getGuestOperationalDayPresence(",
      "export function isGuestOperationallyPresentOnDay(",
      "export function isGuestArrivingOnDay(",
      "export function isGuestDepartingOnDay(",
      "export function getOperationallyPresentGuestsForDay<",
    ]) {
      expect(stayRanges.split(named)).toHaveLength(2);
    }
  });

  it("carries no time-of-day input: the boundary is midday NZ by definition", () => {
    // Epic D-M3. If a threshold, setting or arrival-time input ever reaches
    // this rule it stops being derivable from the night set alone.
    expect(stayRanges).not.toMatch(/arrivalTime|departureTime|getHours|setHours/);
  });

  it("keeps the deprecated flag on LEGACY semantics, never the operational day", () => {
    // PRIVACY CONTRACT. `lodge-display-state.ts` (fenced, issue #58) subtracts
    // only the envelope end from this list to get its NIGHT counts, so giving
    // the flag D-M4 per-segment presence turns a sparse stay's gap morning into
    // a phantom night, breaks sole-occupancy detection and puts guest names and
    // phone numbers on the unauthenticated lobby wall. The per-segment rule
    // belongs to the named helpers only.
    const wrapper = stayRanges.slice(
      stayRanges.indexOf("export function getLodgeVisibleGuestsForDate<"),
    );
    expect(wrapper).toContain("isGuestVisibleOnLodgeDate(guest, date, booking, options)");
    expect(wrapper).not.toContain("getOperationallyPresentGuestsForDay(");

    // The legacy true-branch, byte-for-byte: night-set membership OR the single
    // morning after the FINAL listed night; otherwise the closed envelope.
    const legacyBranch = stayRanges.slice(
      stayRanges.indexOf("function isGuestVisibleOnLodgeDate("),
      stayRanges.indexOf("export function getLodgeVisibleGuestsForDate<"),
    );
    expect(legacyBranch).toContain("if (maxKey === null || key > maxKey) maxKey = key;");
    expect(legacyBranch).toContain("return dateKey === shiftDateOnlyKey(maxKey, 1);");
    expect(legacyBranch).toContain(
      "return stayStartKey <= dateKey && dateKey <= stayEndKey;",
    );
  });

  it("freezes the deprecated includeDepartureDate flag to the #2631 surfaces", () => {
    // The flag is still the wrong way to ask. #2631 converts these three read
    // surfaces and deletes it; until then no fourth caller.
    const callers = allSourceFiles(path.join(ROOT, "src"))
      .filter((file) => !file.includes(`${path.sep}__tests__${path.sep}`))
      .filter((file) => /includeDepartureDate/.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(ROOT, file).replaceAll("\\", "/"))
      .sort();
    expect(callers).toEqual([
      "src/app/api/lodge/guests/[date]/route.ts",
      "src/app/api/lodge/week/route.ts",
      "src/lib/booking-guest-stay-ranges.ts",
      "src/lib/lodge-display-state.ts",
    ]);
  });

  it("MUTATION PROBE: every roster generation path reads the canonical selector", () => {
    // Chore eligibility has exactly one query. If a generation path ever
    // re-grows its own booking/guest predicate, the two can disagree about who
    // was in the lodge — which is the bug #2622 exists to remove.
    for (const consumer of [
      "src/lib/admin-roster-service.ts",
      "src/app/api/lodge/roster/[date]/generate/route.ts",
    ]) {
      const contents = source(consumer);
      expect(contents, consumer).toContain(
        'from "@/lib/roster-eligibility"',
      );
      expect(contents, consumer).toContain("getOperationalRosterGuestsForDate");
      // No local copy of the coarse stay predicate.
      expect(contents, consumer).not.toMatch(/stayEnd: \{ gt: date \}/);
      expect(contents, consumer).not.toMatch(/checkOut: \{ gt: date \}/);
    }
  });

  it("keeps roster eligibility and chore cleanup on the same rule (D-M6)", () => {
    expect(source("src/lib/roster-eligibility.ts")).toContain(
      "getOperationallyPresentGuestsForDay",
    );
    expect(source("src/lib/chore-cleanup.ts")).toContain(
      "isGuestOperationallyPresentOnDay",
    );
  });
});
