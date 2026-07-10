// Disjoint Monday–Wednesday stay windows for the booking persona, starting a
// few weeks out so they clear the demo seed's fixed July bookings. Windows are
// pure date math (NZ date-only lodge nights); the wizard itself rejects a
// window that falls outside a seeded season, which keeps failures loud. The
// base seed covers Winter 2026 (Jun–Sep) and Summer 2026–27 (Nov–Mar), so runs
// during a season gap (e.g. Oct 2026) need reseeded season dates — see
// docs/E2E_PLAYWRIGHT.md.
import {
  IB_WINDOW,
  WAITLIST_FULL_WINDOW,
  WAITLIST_OFFER_WINDOW,
} from "../../prisma/e2e-fixtures";

const FIRST_WINDOW_OFFSET_DAYS = 21;

// The September fixture windows are FIXED dates while stayWindow Mondays drift
// weekly with the run date, so an index periodically lands ON one of them —
// including the seeded-FULL waitlist window (22 guests), where a spec's
// booking creation is refused outright (#1703; first observed as #1686's
// admin-override collision). Every reserved Monday is skipped for every index,
// so windows stay mutually disjoint AND clear of the fixtures on all run dates.
const RESERVED_WINDOW_CHECKINS = new Set<string>([
  IB_WINDOW.checkIn,
  WAITLIST_FULL_WINDOW.checkIn,
  WAITLIST_OFFER_WINDOW.checkIn,
]);

export type StayWindow = {
  checkIn: string; // YYYY-MM-DD (NZ date-only lodge night)
  checkOut: string;
  nights: string[]; // occupied lodge nights: checkIn inclusive, checkOut exclusive
};

function toDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

// Window n = the (n+1)th non-reserved Monday at least FIRST_WINDOW_OFFSET_DAYS
// from today, staying Mon+Tue nights (checkout Wednesday). Each spec uses its
// own index so bookings never collide on a member-night.
export function stayWindow(index: number): StayWindow {
  const earliest = addDays(new Date(), FIRST_WINDOW_OFFSET_DAYS);
  const daysUntilMonday = (8 - earliest.getDay()) % 7; // getDay(): Monday === 1
  let monday = addDays(earliest, daysUntilMonday);
  let remaining = index;
  // Walk Mondays, skipping the reserved fixture check-ins, until the index-th
  // free one. Bounded: only 3 Mondays are reserved, so this always terminates
  // within index + 3 steps.
  for (;;) {
    if (!RESERVED_WINDOW_CHECKINS.has(toDateOnly(monday))) {
      if (remaining === 0) break;
      remaining -= 1;
    }
    monday = addDays(monday, 7);
  }
  const tuesday = addDays(monday, 1);
  const wednesday = addDays(monday, 2);
  return {
    checkIn: toDateOnly(monday),
    checkOut: toDateOnly(wednesday),
    nights: [toDateOnly(monday), toDateOnly(tuesday)],
  };
}

// aria-label date fragment used by the booking calendar day buttons, e.g.
// "Monday, 17 August 2026".
export function calendarDayLabel(dateOnly: string): RegExp {
  const [y, m, d] = dateOnly.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  const weekday = date.toLocaleDateString("en-NZ", { weekday: "long" });
  const month = date.toLocaleDateString("en-NZ", { month: "long" });
  return new RegExp(`^${weekday}, ${d} ${month} ${y},`);
}
