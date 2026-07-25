import { describe, expect, it } from "vitest";
import type { CalendarEventDTO } from "@/lib/calendar-events";
import { groupEventsByDay } from "@/lib/calendar-client";

// Build ISO instants from LOCAL calendar components so the day keys the grouper
// derives (via local getFullYear/Month/Date) are deterministic regardless of the
// test runner's timezone: an instant built from local parts re-parses to the
// same local parts.
function localIso(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
): string {
  return new Date(year, monthIndex, day, hour, minute).toISOString();
}

function makeEvent(overrides: Partial<CalendarEventDTO>): CalendarEventDTO {
  return {
    id: "evt",
    title: "Event",
    location: null,
    details: null,
    allDay: false,
    startsAt: localIso(2026, 7, 15, 9),
    endsAt: null,
    isMeeting: false,
    seriesId: null,
    detachedFromSeries: false,
    recurrence: null,
    ...overrides,
  };
}

/** Day keys whose bucket contains the event with the given id. */
function daysContaining(
  byDay: Map<string, CalendarEventDTO[]>,
  id: string,
): string[] {
  return [...byDay.entries()]
    .filter(([, events]) => events.some((e) => e.id === id))
    .map(([key]) => key)
    .sort();
}

describe("groupEventsByDay — multi-day / midnight-spanning events", () => {
  it("renders a Sat-22:00 → Sun-01:00 event on both Saturday and Sunday", () => {
    // Aug 15 2026 is a Saturday.
    const event = makeEvent({
      id: "overnight",
      startsAt: localIso(2026, 7, 15, 22),
      endsAt: localIso(2026, 7, 16, 1),
    });
    const byDay = groupEventsByDay([event]);
    expect(daysContaining(byDay, "overnight")).toEqual([
      "2026-08-15",
      "2026-08-16",
    ]);
  });

  it("renders a 3-day all-day event on all three days", () => {
    const event = makeEvent({
      id: "camp",
      allDay: true,
      startsAt: localIso(2026, 7, 10, 0),
      endsAt: localIso(2026, 7, 12, 0),
    });
    const byDay = groupEventsByDay([event]);
    expect(daysContaining(byDay, "camp")).toEqual([
      "2026-08-10",
      "2026-08-11",
      "2026-08-12",
    ]);
  });

  it("keeps a same-day timed event in a single bucket", () => {
    const event = makeEvent({
      id: "meeting",
      startsAt: localIso(2026, 7, 20, 9),
      endsAt: localIso(2026, 7, 20, 10),
    });
    const byDay = groupEventsByDay([event]);
    expect(daysContaining(byDay, "meeting")).toEqual(["2026-08-20"]);
  });

  it("keeps an event with a null endsAt in a single bucket", () => {
    const event = makeEvent({
      id: "open-ended",
      startsAt: localIso(2026, 7, 25, 9),
      endsAt: null,
    });
    const byDay = groupEventsByDay([event]);
    expect(daysContaining(byDay, "open-ended")).toEqual(["2026-08-25"]);
  });

  it("keeps the per-bucket ordering (all-day first, then by time) on shared days", () => {
    const allDaySpan = makeEvent({
      id: "span",
      allDay: true,
      startsAt: localIso(2026, 7, 15, 0),
      endsAt: localIso(2026, 7, 16, 0),
    });
    const timed = makeEvent({
      id: "timed",
      startsAt: localIso(2026, 7, 15, 9),
      endsAt: localIso(2026, 7, 15, 10),
    });
    const byDay = groupEventsByDay([timed, allDaySpan]);
    const sat = byDay.get("2026-08-15") ?? [];
    // The all-day span sorts ahead of the timed event on the shared Saturday.
    expect(sat.map((e) => e.id)).toEqual(["span", "timed"]);
  });

  it("caps a pathological span so a malformed endsAt cannot blow up the grid", () => {
    const event = makeEvent({
      id: "runaway",
      startsAt: localIso(2026, 7, 1, 0),
      // A malformed end centuries in the future.
      endsAt: localIso(3000, 0, 1, 0),
    });
    const byDay = groupEventsByDay([event]);
    // Expansion is bounded (MAX_EVENT_SPAN_DAYS + 1 day cells at most).
    expect(daysContaining(byDay, "runaway").length).toBeLessThanOrEqual(371);
    expect(daysContaining(byDay, "runaway").length).toBeGreaterThan(0);
  });
});
