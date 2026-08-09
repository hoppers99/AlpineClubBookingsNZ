import type { AgeTier, DisplayNameGranularity } from "@prisma/client";
import { isValidArrivalTime } from "./arrival-time";
import {
  getGuestStayEnd,
  getGuestStayStart,
  getLodgeVisibleGuestsForDate,
  isGuestActiveOnNight,
} from "./booking-guest-stay-ranges";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "./booking-status";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  getTodayDateOnly,
} from "./date-only";
import { getCachedClubIdentity } from "./public-layout-config";
import {
  CLUB_THEME_ID,
  sanitiseLogoDataUrl,
  sanitiseLogoUrl,
} from "./club-theme-schema";
import { getSanitizedLodgeInstructions } from "./lodge-instructions";
import { DISPLAY_RELEVANT_MODULE_KEYS } from "./lodge-display/conditions";
import { lodgeNullTolerantScope } from "./lodges";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "./member-guest-consent";
import { loadEffectiveModuleFlags } from "./module-settings";
import { canServeMemberPhoneOnLodgeSurface, formatXeroPhone } from "./phone";
import type { ModuleKey } from "@/config/modules";
import { prisma } from "./prisma";

// The lobby display's data contract and privacy serialiser (fork issue #28,
// docs/lobby-display/design.md §5 and §10). THIS FILE IS THE SINGLE
// ENFORCEMENT POINT for what a public screen may show: names leave here
// already reduced to the configured granularity, minors are never
// individually named at any level, and no monetary or member-id field is ever
// selected. Every display module renders as a pure function of the DisplayState
// payload — templates cannot reach past it.
//
// The ONE contact exception (#125 / #37) is a member phone number, and it is
// released per-guest ONLY under the two-sided consent gate
// (`canServeMemberPhoneOnLodgeSurface`): the lodge has enabled phone display
// AND the member has opted in AND the guest is an adult AND the row already
// shows individual names. Both config flags default off, so by default no phone
// ever enters the payload.

export const DEFAULT_DISPLAY_NAME_GRANULARITY: DisplayNameGranularity =
  "FIRST_NAME_SURNAME_INITIAL";

export const DISPLAY_WINDOW_DEFAULT_DAYS = 3;
export const DISPLAY_WINDOW_MAX_DAYS = 7;

// A sole-occupancy booking only collapses to the whole-lodge blockout
// treatment when it is a genuine group take-over: an organisation booking, or
// at least this many guests. Keeps a lone mid-week guest off the blockout
// board. Documented in design.md §10; review-flagged on epic #25.
export const WHOLE_LODGE_MIN_GUESTS = 8;

const MINOR_AGE_TIERS: readonly AgeTier[] = ["INFANT", "CHILD", "YOUTH"];

export interface DisplayStateGuest {
  label: string;
  stayStart: string;
  stayEnd: string;
  /** Adult member phone number — present ONLY when the two-sided consent gate
   * allows it (#125 / #37); omitted otherwise, so the default payload carries
   * no contact field. */
  phone?: string;
}

export interface DisplayStateBooking {
  /** Opaque per-row key — never the real booking id. */
  key: string;
  label: string;
  wholeLodge: boolean;
  roomId: string | null;
  /** Null when names are withheld (counts-only, family, org, whole-lodge). */
  guests: DisplayStateGuest[] | null;
  guestCount: number;
  stayStart: string;
  stayEnd: string;
  /**
   * The booking's expected arrival time as stored, `"HH:mm"` — display-only
   * information so the wall can say when tonight's arrivals are due (#2621,
   * owner decision 8 Aug). Null far more often than not, and null is the
   * ordinary case.
   *
   * IT RIDES THE NAME GATE, NOT ITS OWN. It is only ever non-null on a row that
   * is ALREADY naming individuals — the same `namesAllowed` decision that fills
   * `guests`. A row the wall may not name (a booking with a minor, an
   * organisation, a whole-lodge blockout, or COUNTS_ONLY granularity) gets no
   * time either, because "the group in room B arrives at 5:30" is a movement
   * fact about identifiable people on an unauthenticated public screen, and the
   * whole point of withholding the names was to not publish facts about who
   * those people are and what they are doing.
   *
   * It is also only non-null when the arrival falls INSIDE the board window: a
   * stay that began before the window shows no time, because a time-of-day with
   * no visible day beside it reads as "arriving at 5:30 today" for a guest who
   * arrived last Tuesday.
   *
   * This field CHANGES NO COUNT. It is not read by the occupancy buckets, the
   * night counts, the whole-lodge heuristic or anything else in this builder —
   * it is carried alongside them, unread.
   */
  arrivalTime: string | null;
}

/**
 * The kiosk's club-branding block (#2322).
 *
 * Sanitised HERE, not only on the write path: this surface reads the ClubTheme
 * columns directly rather than through `normaliseThemeValues`, so a hand-edited
 * row or an imported bundle could otherwise put an arbitrary string into an
 * `<img src>` on an unattended public screen. Exported as a test seam.
 */
// test seam
export function clubBrandingForDisplay(
  name: string,
  theme: { logoUrl?: string | null; logoDataUrl?: string | null } | null,
): DisplayState["club"] {
  return {
    name,
    logoUrl: sanitiseLogoUrl(theme?.logoUrl),
    logoDataUrl: sanitiseLogoDataUrl(theme?.logoDataUrl),
  };
}

export interface DisplayState {
  lodge: { name: string };
  /** Club branding for the header brand block (issue #56): the configured
   * club name and the club-theme logo — presentation-only fields already public
   * on every website page. `logoUrl` (#2322) is the served-image form and wins
   * over the legacy inlined `logoDataUrl`. Both are sanitised in
   * `buildDisplayState` before they reach this payload. */
  club: {
    name: string;
    logoUrl: string | null;
    logoDataUrl: string | null;
  };
  generatedAt: string;
  window: { start: string; days: number };
  rooms: Array<{ id: string; name: string }> | null;
  bookings: DisplayStateBooking[];
  occupancy: Array<{
    date: string;
    arriving: number;
    departing: number;
    staying: number;
  }>;
  chores: Array<{ date: string; title: string; assigneeLabels: string[] }>;
  rules: Array<{ title: string; html: string }> | null;
  /** Committee notice board content (#36): admin-authored free text,
   * rendered as text nodes only; {{config:<key>}} placeholders resolve
   * inside it at render. */
  notice: string | null;
  config: Record<string, string>;
  /** Display-relevant module flags only (ADR-003 §3): the capability
   * conditions read these instead of querying, so the evaluator stays a pure
   * function of the payload. Limited to DISPLAY_RELEVANT_MODULE_KEYS — the
   * whole club flag map is never shipped to a public wall. */
  capabilities: Record<string, boolean>;
  /**
   * The custodian(s) in residence today (#2286), or null when there is none.
   *
   * ONLY a bed-holding hut-leader assignment produces this slot: a role-only
   * assignment is not an occupancy and does not appear. The custodian is not a
   * BookingGuest, so their exclusion from the occupancy counts, the booking
   * rows and the chore roster is structural — there is nothing to filter.
   *
   * `count` is how many bed-holding custodians are in residence tonight. It is
   * a COUNT, not a flag, because a handover night legitimately has two people
   * on two different beds — the previous shape (one `findFirst`) silently named
   * one of them and hid the other, which is the one thing a "who is here" slot
   * must not do.
   *
   * `label` is the joined names, or null whenever ANY of them must not be
   * individually named: under COUNTS_ONLY granularity, and ALWAYS when a
   * minor-age custodian is among them regardless of granularity (the
   * file-level contract: minors are never individually named at any level).
   * All-or-nothing on purpose — naming the adult and omitting the minor next to
   * "Custodians" would identify the minor by elimination. The template then
   * renders the role word and the count.
   *
   * No phone, no dates, no member id — the slot carries names or a count.
   */
  custodian: { label: string | null; count: number } | null;
}

function isMinor(ageTier: AgeTier): boolean {
  return MINOR_AGE_TIERS.includes(ageTier);
}

/** Reduce an adult's name to the configured granularity. */
export function reduceName(
  firstName: string,
  lastName: string,
  granularity: DisplayNameGranularity
): string | null {
  const first = firstName.trim();
  const last = lastName.trim();
  switch (granularity) {
    case "FULL_NAME":
      return [first, last].filter(Boolean).join(" ");
    case "FIRST_NAME_SURNAME_INITIAL":
      return last ? `${first} ${last[0].toUpperCase()}` : first;
    case "FIRST_NAME_ONLY":
      return first;
    case "COUNTS_ONLY":
      return null;
  }
}

interface OrganiserShape {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
}

/**
 * Whether a booking's guests may be individually named anywhere on the wall
 * (design.md §10 settled rules; issue #174): a whole-lodge blockout, any
 * minor in the booking, an organisation organiser, or counts-only
 * granularity all suppress individual names in favour of the booking's
 * reduced group label. This is the SINGLE definition of that condition —
 * every board that might name an individual (booking rows, chore assignees)
 * calls this instead of re-deriving the condition list.
 */
export function namesAllowedForBooking(options: {
  wholeLodge: boolean;
  containsMinors: boolean;
  organiserAgeTier: AgeTier;
  granularity: DisplayNameGranularity;
}): boolean {
  return (
    !options.wholeLodge &&
    !options.containsMinors &&
    options.organiserAgeTier !== "NOT_APPLICABLE" &&
    options.granularity !== "COUNTS_ONLY"
  );
}

/**
 * The booking-level label (design.md §10 settled rules):
 * - organisation organiser (schools, clubs): the organisation's full name at
 *   EVERY granularity — organisations are not people;
 * - booking containing minors: a family/group label, never individual names;
 * - otherwise: the organiser's name at the configured granularity.
 */
export function bookingLabel(
  organiser: OrganiserShape,
  options: {
    granularity: DisplayNameGranularity;
    containsMinors: boolean;
    guestCount: number;
  }
): string {
  const { granularity, containsMinors, guestCount } = options;

  if (organiser.ageTier === "NOT_APPLICABLE") {
    return [organiser.firstName.trim(), organiser.lastName.trim()]
      .filter(Boolean)
      .join(" ");
  }

  if (containsMinors) {
    const last = organiser.lastName.trim();
    if (
      last &&
      (granularity === "FULL_NAME" ||
        granularity === "FIRST_NAME_SURNAME_INITIAL")
    ) {
      return `${last} family`;
    }
    return `Family of ${guestCount}`;
  }

  return (
    reduceName(organiser.firstName, organiser.lastName, granularity) ??
    `Guests · ${guestCount}`
  );
}

/** Sanitise the per-lodge config glob to a flat string map with caps. */
export function sanitiseDisplayConfig(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) continue;
    if (typeof value !== "string") continue;
    // Strip control characters; values are additionally HTML-escaped at
    // render time by the config-token resolver (LTV-006).
    out[key] = value.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 500);
  }
  return out;
}

export function clampDisplayWindowDays(requested: number | null): number {
  if (requested === null || !Number.isFinite(requested)) {
    return DISPLAY_WINDOW_DEFAULT_DAYS;
  }
  return Math.min(DISPLAY_WINDOW_MAX_DAYS, Math.max(1, Math.floor(requested)));
}

/**
 * Build the DisplayState payload for one lodge. `lodgeId` comes from the
 * display device's FK (checkDisplayAuth) — every query below is scoped to it
 * and nothing from any other lodge can appear (issue #28 AC5).
 */
export async function buildDisplayState(
  lodgeId: string,
  options: { days?: number | null; windowStart?: Date | null } = {}
): Promise<DisplayState | null> {
  const days = clampDisplayWindowDays(options.days ?? null);
  // `windowStart` is the admin-preview simulated date (issue #60); it only
  // reaches here from the preview branch of the state route — device fetches
  // never pass it, so a real screen always starts today.
  const startDate = options.windowStart ?? getTodayDateOnly();
  const endExclusive = addDaysDateOnly(startDate, days);
  const endInclusive = addDaysDateOnly(endExclusive, -1);
  const windowDates = eachDateOnlyInRange(startDate, endExclusive).slice(0, days);

  const [lodge, flags] = await Promise.all([
    prisma.lodge.findUnique({
      where: { id: lodgeId },
      select: {
        id: true,
        name: true,
        active: true,
        displayConfig: true,
        displayNameGranularity: true,
        displayNotice: true,
        showGuestPhonesOnScreens: true,
      },
    }),
    loadEffectiveModuleFlags(),
  ]);
  if (!lodge || !lodge.active) return null;

  const granularity =
    lodge.displayNameGranularity ?? DEFAULT_DISPLAY_NAME_GRANULARITY;

  const [bookings, rooms, choreRows, instructionDocs] = await Promise.all([
    prisma.booking.findMany({
      where: {
        status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
        checkIn: { lte: endInclusive },
        checkOut: { gte: startDate },
        ...lodgeNullTolerantScope(lodgeId),
        guests: {
          some: {
            stayStart: { lte: endInclusive },
            stayEnd: { gte: startDate },
            ...OPERATIONALLY_PRESENT_GUEST_WHERE,
          },
        },
      },
      select: {
        id: true,
        checkIn: true,
        checkOut: true,
        // #2621: display-only information for the wall's arrival rows. Selected
        // here, gated by `namesAllowed` and the window in the row builder below,
        // and read by NOTHING in the occupancy, night-count, whole-lodge or
        // chore logic in this file.
        expectedArrivalTime: true,
        // Authoritative whole-lodge treatment (#122 / epic #116, ADR-001
        // decision 4): an explicit exclusive hold drives the blockout board,
        // with the sole-occupancy heuristic as the fallback for un-flagged
        // bookings.
        wholeLodgeHold: true,
        member: {
          select: { firstName: true, lastName: true, ageTier: true },
        },
        guests: {
          // Owner decision D-12 (#2307): the wall describes who is actually at
          // the lodge, so an unconsented member guest is not in this set.
          //
          // THIS CHANGES HOW A LODGE IS LABELLED, deliberately. The guest set
          // feeds the sole-occupancy whole-lodge heuristic (guestCount >=
          // WHOLE_LODGE_MIN_GUESTS) and the containsMinors decision, both of
          // which gate whether individual names may be shown at all. A booking
          // that reaches the group threshold only by counting a PENDING guest is
          // not a group on the wall, and a booking whose only minor is a PENDING
          // guest has no minor present. That is the consistent reading of D-12:
          // the board describes the lodge as it will be, not as the capacity
          // ledger holds it. A dedicated test makes the threshold flip visible
          // rather than incidental.
          where: { ...OPERATIONALLY_PRESENT_GUEST_WHERE },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            ageTier: true,
            stayStart: true,
            stayEnd: true,
            // #125 / #37: the member's opt-in + phone, released per-guest only
            // under `canServeMemberPhoneOnLodgeSurface` in the row builder.
            member: {
              select: {
                ageTier: true,
                lodgeScreenPhoneOptIn: true,
                phoneCountryCode: true,
                phoneAreaCode: true,
                phoneNumber: true,
              },
            },
            nights: { select: { stayDate: true } },
            bedAllocations: {
              where: {
                stayDate: { gte: startDate, lte: endInclusive },
              },
              orderBy: { stayDate: "asc" },
              select: { roomId: true },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
    }),
    flags.bedAllocation
      ? prisma.lodgeRoom.findMany({
          where: { active: true, lodgeId },
          orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    flags.chores
      ? prisma.choreAssignment.findMany({
          where: {
            date: { gte: startDate, lt: endExclusive },
            booking: {
              status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
              ...lodgeNullTolerantScope(lodgeId),
            },
          },
          orderBy: [{ date: "asc" }],
          select: {
            date: true,
            choreTemplate: { select: { name: true } },
            bookingGuest: {
              select: { firstName: true, lastName: true, ageTier: true },
            },
            booking: {
              select: {
                // `id` looks the booking up in `wholeLodgeBookingIds` below —
                // the same whole-lodge decision the booking rows use (#174).
                id: true,
                member: {
                  select: { firstName: true, lastName: true, ageTier: true },
                },
                // D-12 (#2307): the chore panel re-derives containsMinors and
                // the group headcount for its own assignee label, so it has to
                // read the SAME guest set as the booking rows above or the two
                // panels would label one booking two different ways on one wall.
                guests: {
                  where: { ...OPERATIONALLY_PRESENT_GUEST_WHERE },
                  select: { ageTier: true },
                },
              },
            },
          },
        })
      : Promise.resolve([]),
    getSanitizedLodgeInstructions(lodgeId),
  ]);

  // --- occupancy + per-booking visibility per window day -------------------
  const perBookingDayCounts = new Map<string, Map<string, number>>();
  // NIGHT counts (departure day excluded) drive whole-lodge detection: a
  // group leaving Monday morning still had the lodge to itself even when
  // someone arrives Monday evening (issue #58 — the departure-day overlap
  // used to break the blockout for every back-to-back handover).
  const perBookingNightCounts = new Map<string, Map<string, number>>();
  const nightTotals = new Map<string, number>();
  const occupancy = windowDates.map((date) => {
    const dateKey = formatDateOnly(date);
    let arriving = 0;
    let departing = 0;
    let staying = 0;

    for (const booking of bookings) {
      const visible = getLodgeVisibleGuestsForDate(
        booking.guests,
        date,
        booking,
        { includeDepartureDate: true }
      );
      if (visible.length > 0) {
        let dayMap = perBookingDayCounts.get(booking.id);
        if (!dayMap) {
          dayMap = new Map();
          perBookingDayCounts.set(booking.id, dayMap);
        }
        dayMap.set(dateKey, visible.length);
      }
      // NIGHTS, asked as a night question (#2628). This used to subtract the
      // envelope end — "everyone visible except whoever's `stayEnd` is today" —
      // which is the same set only because the visibility rule above happens to
      // add exactly one departure morning per stay. Reading the night model
      // directly is byte-identical today for every stay, contiguous or sparse,
      // and it means a later change to who is VISIBLE on the wall can no longer
      // silently invent a night here. It is the phantom night that matters: a
      // sole-occupancy count is what decides whether an unauthenticated screen
      // prints guests' names (INV-DATE-006, issue #58).
      const nightGuests = visible.filter((guest) =>
        isGuestActiveOnNight(guest, date, booking)
      );
      if (nightGuests.length > 0) {
        let nightMap = perBookingNightCounts.get(booking.id);
        if (!nightMap) {
          nightMap = new Map();
          perBookingNightCounts.set(booking.id, nightMap);
        }
        nightMap.set(dateKey, nightGuests.length);
        nightTotals.set(dateKey, (nightTotals.get(dateKey) ?? 0) + nightGuests.length);
      }
      staying += visible.length;
      arriving += visible.filter(
        (guest) => getGuestStayStart(guest, booking).getTime() === date.getTime()
      ).length;
      departing += visible.filter(
        (guest) => getGuestStayEnd(guest, booking).getTime() === date.getTime()
      ).length;
    }

    return { date: dateKey, arriving, departing, staying };
  });

  // --- whole-lodge detection: an explicit exclusive hold is AUTHORITATIVE
  // (#122 / epic #116, ADR-001 decision 4) — a flagged booking always gets the
  // blockout treatment regardless of headcount. The sole-occupancy heuristic
  // (design.md §10: sole occupancy on every NIGHT the booking covers AND a
  // genuine group — organisation or >= threshold) is the fallback for
  // un-flagged bookings.
  const wholeLodgeBookingIds = new Set<string>();
  for (const booking of bookings) {
    if (booking.wholeLodgeHold) {
      wholeLodgeBookingIds.add(booking.id);
      continue;
    }
    const nightMap = perBookingNightCounts.get(booking.id);
    if (!nightMap || nightMap.size === 0) continue;
    const isSoleOnAllNights = [...nightMap.entries()].every(
      ([dateKey, count]) => nightTotals.get(dateKey) === count
    );
    const guestCount = booking.guests.length;
    const isOrganisation = booking.member.ageTier === "NOT_APPLICABLE";
    if (isSoleOnAllNights && (isOrganisation || guestCount >= WHOLE_LODGE_MIN_GUESTS)) {
      wholeLodgeBookingIds.add(booking.id);
    }
  }

  // --- booking rows: split per (booking, room); privacy-reduce labels ------
  const rows: DisplayStateBooking[] = [];
  for (const booking of bookings) {
    if (!perBookingDayCounts.has(booking.id)) continue; // nothing visible in window

    const containsMinors = booking.guests.some((guest) => isMinor(guest.ageTier));
    const wholeLodge = wholeLodgeBookingIds.has(booking.id);
    const label = bookingLabel(booking.member, {
      granularity,
      containsMinors,
      guestCount: booking.guests.length,
    });
    // Individual names appear only when every privacy condition allows it.
    const namesAllowed = namesAllowedForBooking({
      wholeLodge,
      containsMinors,
      organiserAgeTier: booking.member.ageTier,
      granularity,
    });

    const byRoom = new Map<string | null, typeof booking.guests>();
    for (const guest of booking.guests) {
      const inWindow =
        getGuestStayStart(guest, booking).getTime() <= endInclusive.getTime() &&
        getGuestStayEnd(guest, booking).getTime() >= startDate.getTime();
      if (!inWindow) continue;
      const roomId =
        rooms === null ? null : guest.bedAllocations[0]?.roomId ?? null;
      const group = byRoom.get(roomId) ?? [];
      group.push(guest);
      byRoom.set(roomId, group);
    }

    let rowIndex = 0;
    for (const [roomId, guests] of byRoom) {
      const stayStarts = guests.map((g) => getGuestStayStart(g, booking).getTime());
      const stayEnds = guests.map((g) => getGuestStayEnd(g, booking).getTime());
      const rowStayStart = Math.min(...stayStarts);
      // #2621 — the expected arrival time, and the four things that must all be
      // true before an unauthenticated wall may print it.
      //
      // 1. `namesAllowed`. Identical gate to `guests` below, deliberately
      //    re-used rather than re-derived: a row the wall may not name may not
      //    carry a movement time for the people on it either. A minor in the
      //    booking, an organisation organiser, a whole-lodge blockout or
      //    COUNTS_ONLY granularity each suppress it, exactly as they suppress
      //    the names.
      // 2. The row's own start is inside the window. A time-of-day printed
      //    against a bar that begins before the board's first day reads as
      //    tonight, and would be wrong every day after the first.
      // 3. THE ROW STARTS AT THE BOOKING'S CHECK-IN. The stored value describes
      //    when the BOOKING arrives, and nothing else — there is one time per
      //    booking, no per-guest and no per-room time. A row's start can be
      //    later than the booking's check-in in two ordinary ways: a guest with
      //    their own later `stayStart` (a partial stay, #713), and a per-room
      //    split where one room fills up later in the stay. In both cases
      //    condition 2 is satisfied while the booking itself checked in days
      //    earlier, and the bar would print `arr 5:30 PM` beside a mid-window
      //    start as though that party were arriving tonight. So the time rides
      //    only the row that really is the booking's arrival; every other row of
      //    the same booking shows none. (`rowStayStart` is a date-only
      //    millisecond value on both sides — `getGuestStayStart` falls back to
      //    `booking.checkIn` itself — so the equality is exact, not a
      //    same-day-ish comparison.)
      // 4. The stored value matches the canonical shape. The wall is stricter
      //    than the kiosk here — this file is the single enforcement point for
      //    what a public screen may show, so it renders only values of the
      //    known form, and a malformed pre-#2621 row degrades to no time rather
      //    than to arbitrary text on a lobby TV.
      //
      // Nothing above touches a count. `stayStarts`/`stayEnds` are the existing
      // arrays; `rowStayStart` only replaces the `Math.min` that was already
      // inlined into `stayStart` below, and produces the identical value.
      const arrivalTime =
        namesAllowed &&
        booking.expectedArrivalTime !== null &&
        rowStayStart >= startDate.getTime() &&
        rowStayStart === booking.checkIn.getTime() &&
        isValidArrivalTime(booking.expectedArrivalTime)
          ? booking.expectedArrivalTime
          : null;
      rows.push({
        key: `row-${rows.length + 1}-${rowIndex++}`,
        label,
        wholeLodge,
        roomId,
        guests: namesAllowed
          ? guests.map((guest) => {
              // Phone rides the same row that already shows an individual name.
              // The member's own age tier decides adulthood (falls back to the
              // guest tier for a non-member guest, who has no opt-in and so is
              // filtered out anyway).
              const phone =
                guest.member &&
                canServeMemberPhoneOnLodgeSurface({
                  lodgeShowGuestPhonesOnScreens: lodge.showGuestPhonesOnScreens,
                  memberOptedIn: guest.member.lodgeScreenPhoneOptIn,
                  ageTier: guest.member.ageTier ?? guest.ageTier,
                })
                  ? formatXeroPhone(guest.member)
                  : null;
              return {
                label:
                  reduceName(guest.firstName, guest.lastName, granularity) ?? "",
                stayStart: formatDateOnly(getGuestStayStart(guest, booking)),
                stayEnd: formatDateOnly(getGuestStayEnd(guest, booking)),
                ...(phone ? { phone } : {}),
              };
            })
          : null,
        guestCount: guests.length,
        stayStart: formatDateOnly(new Date(rowStayStart)),
        stayEnd: formatDateOnly(new Date(Math.max(...stayEnds))),
        arrivalTime,
      });
    }
  }

  // --- chores: assignee labels obey the SAME namesAllowed decision as the
  // booking rows (#174) — a chore assignee is never named more precisely
  // than that booking's own row on the wall.
  const chores = choreRows.map((assignment) => {
    const assignee = assignment.bookingGuest;
    let assigneeLabels: string[] = [];
    if (assignee) {
      const bookingContainsMinors = assignment.booking.guests.some((guest) =>
        isMinor(guest.ageTier)
      );
      const namesAllowed = namesAllowedForBooking({
        wholeLodge: wholeLodgeBookingIds.has(assignment.booking.id),
        containsMinors: bookingContainsMinors,
        organiserAgeTier: assignment.booking.member.ageTier,
        granularity,
      });
      if (namesAllowed) {
        const label = reduceName(
          assignee.firstName,
          assignee.lastName,
          granularity
        );
        assigneeLabels = label ? [label] : [];
      } else {
        // Names are withheld for this booking (minor present, whole-lodge,
        // organisation organiser, or counts-only): fall back to the
        // booking's reduced group label rather than the assignee's name.
        assigneeLabels = [
          bookingLabel(assignment.booking.member, {
            granularity,
            containsMinors: bookingContainsMinors,
            guestCount: assignment.booking.guests.length,
          }),
        ];
      }
    }
    return {
      date: formatDateOnly(assignment.date),
      title: assignment.choreTemplate.name,
      assigneeLabels,
    };
  });

  // Only the display-relevant module flags reach the public payload — never
  // the whole club flag map (ADR-003 §3). The capability conditions read these.
  const capabilities: Record<string, boolean> = Object.fromEntries(
    (Object.keys(DISPLAY_RELEVANT_MODULE_KEYS) as ModuleKey[]).map((key) => [
      key,
      Boolean(flags[key]),
    ])
  );

  // Club branding is best-effort: a missing theme row must never take the
  // board down, so failures degrade to a text-only brand block.
  const theme = await prisma.clubTheme
    .findUnique({
      where: { id: CLUB_THEME_ID },
      select: { logoUrl: true, logoDataUrl: true },
    })
    .catch(() => null);

  // DB-first club name (E3 #1929, leak fixed C5 #1984): resolve through
  // ClubIdentitySettings so an admin rename reaches the lobby display, instead of
  // reading the raw config/club.json name. Uses the tagged 15s cache (invalidated
  // by the admin identity PUT via invalidatePublicClubIdentity) rather than an
  // uncached read, because /api/display/state is polled. Never throws — falls
  // back to config.
  const clubIdentity = await getCachedClubIdentity();

  // Custodian in residence (#2286). Scoped to this lodge and to the window's
  // CURRENT day — the wall answers "who is here now", not "who will be here on
  // Thursday". `bedId: not null` is the whole gate: a role-only assignment is
  // not an occupancy and never renders a slot.
  //
  // Gated on the hutLeaders module like every other module-owned read in this
  // builder (`flags.bedAllocation` for rooms, `flags.chores` for the roster): a
  // club with the module off has no hut-leader surface at all, so the wall must
  // not grow one. The query is skipped entirely rather than filtered later.
  //
  // findMany, NOT findFirst (#2286 review B11): a handover night has TWO
  // custodians on two different beds, and a findFirst named one and silently
  // dropped the other. `take` is a sanity bound — the assignment overlap rule
  // permits a one-day handover, so more than a handful on one night means bad
  // data, not a case to render.
  const custodianAssignments = flags.hutLeaders
    ? await prisma.hutLeaderAssignment.findMany({
        where: {
          bedId: { not: null },
          startDate: { lte: startDate },
          endDate: { gte: startDate },
          ...lodgeNullTolerantScope(lodgeId),
        },
        select: {
          member: { select: { firstName: true, lastName: true, ageTier: true } },
        },
        orderBy: [{ startDate: "asc" }, { id: "asc" }],
        take: 8,
      })
    : [];
  // A minor is never individually named at ANY granularity (the contract at the
  // top of this file). Nothing structurally stops a minor-age member being made
  // custodian, so the guard lives here rather than relying on the admin
  // surface. All-or-nothing across the whole set: naming one of two custodians
  // and withholding the other would identify the withheld person by
  // elimination, so one un-nameable custodian withholds every name and the wall
  // falls back to the role word plus the count.
  const custodianNames = custodianAssignments.map((assignment) =>
    isMinor(assignment.member.ageTier)
      ? null
      : reduceName(
          assignment.member.firstName,
          assignment.member.lastName,
          granularity,
        ),
  );
  const custodian =
    custodianAssignments.length > 0
      ? {
          label: custodianNames.every((name) => name)
            ? custodianNames.join(" · ")
            : null,
          count: custodianAssignments.length,
        }
      : null;

  return {
    lodge: { name: lodge.name },
    club: clubBrandingForDisplay(clubIdentity.name, theme),
    generatedAt: new Date().toISOString(),
    window: { start: formatDateOnly(startDate), days },
    rooms,
    bookings: rows,
    occupancy,
    chores,
    rules:
      instructionDocs.length > 0
        ? instructionDocs.map((doc) => ({
            title: doc.title,
            html: doc.contentHtml,
          }))
        : null,
    notice:
      lodge.displayNotice && lodge.displayNotice.trim().length > 0
        ? lodge.displayNotice.trim().slice(0, 2000)
        : null,
    config: sanitiseDisplayConfig(lodge.displayConfig),
    capabilities,
    custodian,
  };
}
