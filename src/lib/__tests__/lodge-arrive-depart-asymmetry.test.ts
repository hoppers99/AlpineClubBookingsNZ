/**
 * #2631 — the arrive/depart lookups must NOT be unified onto the presence rule.
 *
 * This issue converted every lodge READ surface onto one operational-day rule,
 * which makes the two lookups in `lodge-date-scoping.ts` look like stragglers.
 * They are not. They are the kiosk's WRITE path, and they answer different
 * questions on purpose:
 *
 *   findLodgeGuestForDate         (arrive) — NIGHT-only. You can be marked
 *     arrived for a night you are actually sleeping here, and no other day.
 *   findLodgeGuestDepartingOnDate (depart) — the EXACT checkout date. You leave
 *     on one specific day, not on any day you happen to be in the building.
 *
 * Collapse either into `isGuestOperationallyPresentOnDay` and a guest becomes
 * markable-ARRIVED on the morning they are driving home — the operational day
 * covers both halves, and "present" cannot tell them apart. The third function
 * in that file, `validateRosterAllocationsForDate`, IS the operational-day
 * question ("was this person in the building today?") and is deliberately on
 * the shared rule; the contrast is the point.
 *
 * Frozen clock discipline: fixtures are anchored to 2026-07-01T00:00:00Z.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    bookingGuest: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  findLodgeGuestDepartingOnDate,
  findLodgeGuestForDate,
} from "@/lib/lodge-date-scoping";

function day(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

// Last night was the 3rd; they leave on the morning of the 4th.
const DEPARTURE_MORNING = day("2026-07-04");

describe("the arrive/depart asymmetry survives the operational-day unification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("arrive stays NIGHT-only: a guest is not markable-arrived on their departure morning", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(null);

    await findLodgeGuestForDate("guest-1", DEPARTURE_MORNING, "lodge-1");

    const { where } = mockPrisma.bookingGuest.findFirst.mock.calls[0][0];
    // Half-open, exclusive of the checkout day — the night model. If this ever
    // became `gte`, or the operational-day rule, the kiosk would let a leader
    // check in somebody who is loading the car.
    expect(where.stayEnd).toEqual({ gt: DEPARTURE_MORNING });
    expect(where.booking.checkOut).toEqual({ gt: DEPARTURE_MORNING });
  });

  it("depart stays pinned to the EXACT checkout date, not to presence", async () => {
    mockPrisma.bookingGuest.findFirst.mockResolvedValue(null);

    await findLodgeGuestDepartingOnDate("guest-1", DEPARTURE_MORNING, "lodge-1");

    const { where } = mockPrisma.bookingGuest.findFirst.mock.calls[0][0];
    // Equality, not a range: a guest mid-stay is present on today's operational
    // day but is not departing today, and must not be markable departed.
    expect(where.stayEnd).toEqual(DEPARTURE_MORNING);
    expect(where.booking.checkOut).toEqual({ gte: DEPARTURE_MORNING });
  });

  it("SOURCE CONTRACT: neither lookup is rewritten in terms of the presence helper", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/lib/lodge-date-scoping.ts"),
      "utf8",
    );

    const arrive = source.slice(
      source.indexOf("export async function findLodgeGuestForDate("),
      source.indexOf("export async function findLodgeGuestDepartingOnDate("),
    );
    const depart = source.slice(
      source.indexOf("export async function findLodgeGuestDepartingOnDate("),
      source.indexOf("export async function validateRosterAllocationsForDate("),
    );

    for (const [name, body] of [
      ["arrive", arrive],
      ["depart", depart],
    ] as const) {
      expect(body.length, name).toBeGreaterThan(0);
      expect(body, name).not.toContain("isGuestOperationallyPresentOnDay");
      expect(body, name).not.toContain("getGuestOperationalDayPresence");
      expect(body, name).not.toContain("getOperationallyPresentGuestsForDay");
    }

    // The comment explaining WHY has to stay with them: the next reader
    // tidying up "the last two night-model callers" needs to find it.
    expect(source).toContain("THE ARRIVE/DEPART ASYMMETRY IS DELIBERATE");

    // …and the contrast: roster validation IS on the shared rule.
    const validate = source.slice(
      source.indexOf("export async function validateRosterAllocationsForDate("),
    );
    expect(validate).toContain("isGuestOperationallyPresentOnDay");
  });
});
