"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  formatDateOnly,
  formatMonthOnly,
  getTodayDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";
import { CalendarDays, ChevronLeft, ChevronRight, Users } from "lucide-react";

type OccupancyCalendarMode = "range" | "single";

export type OccupancyCalendarBooking = {
  id: string;
  reference: string;
  ownerName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  status: string;
};

type OccupancyCalendarNight = {
  date: string;
  guestCount: number;
  bookings: OccupancyCalendarBooking[];
};

type OccupancyCalendarResponse = {
  month: string;
  nights: OccupancyCalendarNight[];
  bookings: OccupancyCalendarBooking[];
};

// Re-exported so no caller import changes when the tone vocabulary moved out.
// `CalendarOverlayEmphasis` is deliberately NOT re-exported: nothing imports it
// from here, and knip counts a re-export nobody consumes as dead surface.
export type {
  CalendarTone,
  CalendarOverlayValue,
} from "./occupancy-calendar-tones";
import type {
  CalendarTone,
  CalendarOverlayValue,
} from "./occupancy-calendar-tones";
import { CALENDAR_TONE_CLASSES } from "./occupancy-calendar-tones";

type OccupancyCalendarProps = {
  mode: OccupancyCalendarMode;
  /**
   * The lodge whose occupancy this shows (#2887). REQUIRED, not
   * optional-with-a-default: the route refuses a lodgeless request (400), so
   * omitting it yields a permanently dead heat-map. Required makes that a
   * compile error. Both callers render only once their scope has settled.
   */
  lodgeId: string;
  selectedStartDate?: string;
  selectedEndDate?: string;
  onSelectionChange: (selection: { startDate: string; endDate: string }) => void;
  // Optional per-date colour overlay (e.g. roster status). Backwards compatible:
  // consumers that pass none behave exactly as before. An entry may set
  // emphasis: "ring" to paint a low-emphasis outline instead of a solid fill.
  overlayByDate?: Record<string, CalendarOverlayValue>;
  overlayLegend?: Array<{ tone: CalendarTone; label: string }>;
  // Does THIS overlay colour the operational DAY (the night plus the following
  // morning) rather than the night? (#2631)
  //
  // Only the roster overlay does. The hut-leader assignment calendar paints
  // `hut-leader-coverage`, which is night-based and fenced, so telling its user
  // that "the day colours count who is in the lodge that day, including a
  // checkout morning" would be a plain falsehood about their screen. The
  // explainer beneath the grid is therefore opt-in per caller and NOT inferred
  // from "an overlay exists", which is what shipped it onto the wrong page.
  overlayCountsOperationalDay?: boolean;
  // Fires with the visible month key (YYYY-MM) on mount and every navigation, so
  // a parent can lazily load overlay data for the month in view.
  onVisibleMonthChange?: (month: string) => void;
};

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Every receiver here is a `getMonthStart` result — `parseDateOnly` of a
// `yyyy-MM-01` string, so UTC midnight and a date-only value by construction —
// which is why the canonical month encoder reads back the month it encodes
// (INV-DATE-010) and why this must NOT become the club-timezone helper: see the
// "Deliberately UTC, NOT club time" note on `visibleMonth` below. It assembled
// the key from UTC parts until #2684, which is the truncation in a fourth
// spelling and invisible to a census that looks for the ISO ones.
function monthKey(date: Date) {
  return formatMonthOnly(date);
}

function getMonthStart(date: Date) {
  return parseDateOnly(`${monthKey(date)}-01`);
}

function monthKeysForDateRange(startDate: string, endDate: string) {
  const start = getMonthStart(parseDateOnly(startDate));
  const end = getMonthStart(parseDateOnly(endDate));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) {
    return [];
  }

  const keys: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    keys.push(monthKey(cursor));
    cursor = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
    );
  }
  return keys;
}

function getMonthGrid(year: number, monthIndex: number) {
  const firstDay = new Date(Date.UTC(year, monthIndex, 1));
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const day = firstDay.getUTCDay();
  const startOffset = day === 0 ? 6 : day - 1;
  return { daysInMonth, startOffset };
}

// Not one of the shared `nzst-date` helpers (#2264): the cell label deliberately
// carries the weekday and drops the year — the year is already stated by the
// month heading above the grid, and a day cell has no room for it. The zone is
// pinned to club time so a `parseDateOnly` UTC-midnight value cannot slide back
// a day for an admin whose browser sits west of UTC.
const CELL_WEEKDAY_DATE = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
});

// Deliberately UTC, NOT club time. `visibleMonth` is a UTC-midnight month start
// and the grid around it is built from `getUTCFullYear`/`getUTCMonth`, so the
// heading has to be read in the same zone as the grid it names — re-zoning it to
// Pacific/Auckland would print the wrong month on the first/last day boundary.
const VISIBLE_MONTH_LABEL = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});

function formatDisplayDate(dateString: string) {
  return CELL_WEEKDAY_DATE.format(parseDateOnly(dateString));
}

export function OccupancyCalendar({
  mode,
  lodgeId,
  selectedStartDate,
  selectedEndDate,
  onSelectionChange,
  overlayByDate,
  overlayLegend,
  overlayCountsOperationalDay = false,
  onVisibleMonthChange,
}: OccupancyCalendarProps) {
  const today = formatDateOnly(getTodayDateOnly());
  const initialMonth = selectedStartDate ? parseDateOnly(selectedStartDate) : getTodayDateOnly();
  const [visibleMonth, setVisibleMonth] = useState(() => getMonthStart(initialMonth));
  const [occupancyByMonth, setOccupancyByMonth] = useState<
    Record<string, OccupancyCalendarResponse>
  >({});
  const [loadingMonthKeys, setLoadingMonthKeys] = useState<string[]>([]);
  const [failedMonthKeys, setFailedMonthKeys] = useState<string[]>([]);
  const [loadError, setLoadError] = useState("");
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
  const requestedMonthKeys = useRef(new Set<string>());
  const visibleMonthKey = monthKey(visibleMonth);

  /*
    #2887: the month caches below are keyed by month alone, so they belong to
    ONE lodge. The ownership ref moves in the COMMIT — same rule and reasoning
    as every other lodge-scope fence here; see
    `src/lib/__tests__/lodge-scope-committed-ownership.test.tsx`.
  */
  const activeLodgeRef = useRef(lodgeId);
  useLayoutEffect(() => {
    activeLodgeRef.current = lodgeId;
  }, [lodgeId]);

  /*
    …and the caches are dropped when the lodge CHANGES, so Lodge A's heat-map
    cannot sit under Lodge B's heading. Declared BEFORE the month-loading
    effects: effects flush in declaration order, so this clears first.

    The `previousLodgeRef` guard is load-bearing. Without it this fires on MOUNT
    too, and `setOccupancyByMonth({})` returns a fresh object identity, re-running
    the month-loading effect whose cleanup cancels the first request and starts a
    second — a double fetch on every mount, and in test it swallowed the failure
    state (the cancelled attempt's `.catch` is a no-op and the retry succeeded).
  */
  const previousLodgeRef = useRef(lodgeId);
  useEffect(() => {
    if (previousLodgeRef.current === lodgeId) return;
    previousLodgeRef.current = lodgeId;
    requestedMonthKeys.current.clear();
    setOccupancyByMonth({});
    setLoadingMonthKeys([]);
    setFailedMonthKeys([]);
    setLoadError("");
  }, [lodgeId]);

  useEffect(() => {
    onVisibleMonthChange?.(visibleMonthKey);
  }, [visibleMonthKey, onVisibleMonthChange]);

  useEffect(() => {
    if (!selectedStartDate) return;
    const parsed = parseDateOnly(selectedStartDate);
    if (!Number.isNaN(parsed.getTime())) {
      setVisibleMonth(getMonthStart(parsed));
    }
  }, [selectedStartDate]);

  const loadMonth = useCallback((month: string) => {
    if (requestedMonthKeys.current.has(month)) {
      return undefined;
    }
    // #2887: no lodge, no read. The route refuses a lodgeless request, so
    // firing one only paints the failure banner over an empty grid.
    const requestedLodgeId = lodgeId;
    if (!requestedLodgeId) return undefined;

    let cancelled = false;
    requestedMonthKeys.current.add(month);
    setLoadingMonthKeys((current) =>
      current.includes(month) ? current : [...current, month],
    );
    setFailedMonthKeys((current) => current.filter((key) => key !== month));
    setLoadError("");

    fetch(
      `/api/admin/occupancy?month=${month}&lodgeId=${encodeURIComponent(requestedLodgeId)}`,
    )
      .then((res) => {
        if (!res.ok) throw new Error("Failed to load occupancy");
        return res.json() as Promise<OccupancyCalendarResponse>;
      })
      .then((data) => {
        // The month caches are keyed by month alone, so a response that
        // outlived its lodge must not land in them.
        if (!cancelled && activeLodgeRef.current === requestedLodgeId) {
          setOccupancyByMonth((current) => ({
            ...current,
            [month]: data,
          }));
          setFailedMonthKeys((current) => current.filter((key) => key !== month));
        }
      })
      .catch(() => {
        if (!cancelled && activeLodgeRef.current === requestedLodgeId) {
          setFailedMonthKeys((current) =>
            current.includes(month) ? current : [...current, month],
          );
          setLoadError("Occupancy could not be loaded.");
        }
      })
      .finally(() => {
        // #2887 review (F6): guarded like the other three callbacks. Deleting
        // the in-flight marker unconditionally let a late Lodge-A response
        // clear Lodge-B's marker, so B's month looked unrequested and a re-run
        // fetched it twice. Data-safe, but a wasted request.
        if (activeLodgeRef.current === requestedLodgeId) {
          requestedMonthKeys.current.delete(month);
        }
        if (!cancelled && activeLodgeRef.current === requestedLodgeId) {
          setLoadingMonthKeys((current) => current.filter((key) => key !== month));
        }
      });

    return () => {
      cancelled = true;
      requestedMonthKeys.current.delete(month);
    };
  }, [lodgeId]);

  useEffect(() => {
    if (!occupancyByMonth[visibleMonthKey]) {
      return loadMonth(visibleMonthKey);
    }
    setLoadError("");
    return undefined;
  }, [loadMonth, occupancyByMonth, visibleMonthKey]);

  const visibleOccupancy = occupancyByMonth[visibleMonthKey] ?? null;

  const nightsByDate = useMemo(() => {
    return new Map(
      (visibleOccupancy?.nights ?? []).map((night) => [night.date, night]),
    );
  }, [visibleOccupancy]);

  const selectedPanelRange = useMemo(() => {
    if (!selectedStartDate) return null;
    const endDate = mode === "single" ? selectedStartDate : selectedEndDate || selectedStartDate;
    if (endDate < selectedStartDate) return null;
    return { startDate: selectedStartDate, endDate };
  }, [mode, selectedEndDate, selectedStartDate]);

  const selectedMonthKeys = useMemo(() => {
    if (!selectedPanelRange) return [];
    return monthKeysForDateRange(
      selectedPanelRange.startDate,
      selectedPanelRange.endDate,
    );
  }, [selectedPanelRange]);
  const selectedMonthKeySignature = selectedMonthKeys.join("|");

  useEffect(() => {
    const months = selectedMonthKeySignature
      ? selectedMonthKeySignature.split("|")
      : [];
    for (const month of months) {
      if (!occupancyByMonth[month]) {
        return loadMonth(month);
      }
    }
    return undefined;
  }, [loadMonth, occupancyByMonth, selectedMonthKeySignature]);

  const selectedOccupancyMonths = useMemo(
    () =>
      selectedMonthKeys
        .map((month) => occupancyByMonth[month])
        .filter(
          (occupancy): occupancy is OccupancyCalendarResponse => Boolean(occupancy),
        ),
    [occupancyByMonth, selectedMonthKeys],
  );

  const selectedBookings = useMemo(() => {
    if (!selectedPanelRange) return [];
    const bookingTotals = new Map<string, OccupancyCalendarBooking>();
    for (const occupancy of selectedOccupancyMonths) {
      for (const night of occupancy.nights) {
        if (
          night.date < selectedPanelRange.startDate ||
          night.date > selectedPanelRange.endDate
        ) {
          continue;
        }
        for (const booking of night.bookings) {
          const existing = bookingTotals.get(booking.id);
          bookingTotals.set(booking.id, {
            ...booking,
            guestCount: (existing?.guestCount ?? 0) + booking.guestCount,
          });
        }
      }
    }
    return [...bookingTotals.values()];
  }, [selectedOccupancyMonths, selectedPanelRange]);

  const selectedGuestCount = useMemo(() => {
    if (!selectedPanelRange) return 0;
    return selectedOccupancyMonths
      .flatMap((occupancy) => occupancy.nights)
      .filter(
        (night) =>
          night.date >= selectedPanelRange.startDate &&
          night.date <= selectedPanelRange.endDate,
      )
      .reduce((total, night) => total + night.guestCount, 0);
  }, [selectedOccupancyMonths, selectedPanelRange]);

  const selectedRangeLoading = Boolean(
    selectedPanelRange &&
      selectedMonthKeys.some(
        (month) =>
          loadingMonthKeys.includes(month) ||
          (!occupancyByMonth[month] && !failedMonthKeys.includes(month)),
      ),
  );
  const selectedRangeLoadFailed = Boolean(
    selectedPanelRange &&
      selectedMonthKeys.some(
        (month) => failedMonthKeys.includes(month) && !occupancyByMonth[month],
      ),
  );

  function moveMonth(delta: number) {
    setVisibleMonth((current) =>
      new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + delta, 1)),
    );
  }

  function handleDayClick(dateString: string) {
    if (dateString < today) return;

    if (mode === "single") {
      setRangeAnchor(null);
      onSelectionChange({ startDate: dateString, endDate: dateString });
      return;
    }

    if (!rangeAnchor || selectedEndDate) {
      setRangeAnchor(dateString);
      onSelectionChange({ startDate: dateString, endDate: "" });
      return;
    }

    if (dateString < rangeAnchor) {
      setRangeAnchor(dateString);
      onSelectionChange({ startDate: dateString, endDate: "" });
      return;
    }

    onSelectionChange({ startDate: rangeAnchor, endDate: dateString });
    setRangeAnchor(null);
  }

  const year = visibleMonth.getUTCFullYear();
  const monthIndex = visibleMonth.getUTCMonth();
  const { daysInMonth, startOffset } = getMonthGrid(year, monthIndex);
  const visibleMonthLabel = VISIBLE_MONTH_LABEL.format(visibleMonth);

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => moveMonth(-1)}
            aria-label="Previous month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-36 text-center text-sm font-semibold text-foreground">
            {visibleMonthLabel}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => moveMonth(1)}
            aria-label="Next month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <CalendarDays className="h-4 w-4" />
          {loadingMonthKeys.includes(visibleMonthKey)
            ? "Loading occupancy..."
            : "Operational bookings only"}
        </div>
      </div>

      {loadError && (
        <div className="border-b border-danger/30 bg-danger-muted px-3 py-2 text-sm text-danger">
          {loadError}
        </div>
      )}

      <div className="grid grid-cols-7 border-b border-border">
        {DAY_LABELS.map((label) => (
          <div key={label} className="px-1 py-2 text-center text-xs font-medium text-muted-foreground">
            {label}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {Array.from({ length: startOffset }).map((_, index) => (
          <div key={`empty-${index}`} className="min-h-16 border-b border-r border-border bg-muted" />
        ))}
        {Array.from({ length: daysInMonth }, (_, index) => {
          const day = index + 1;
          const dateString = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
          const night = nightsByDate.get(dateString);
          const isPast = dateString < today;
          const isSelectedStart = dateString === selectedStartDate;
          const isSelectedEnd = dateString === selectedEndDate;
          const isInRange = Boolean(
            selectedStartDate &&
              selectedEndDate &&
              dateString > selectedStartDate &&
              dateString < selectedEndDate,
          );
          const selectedSingleDate =
            isSelectedStart &&
            (mode === "single" || selectedStartDate === selectedEndDate);
          const selectionLabel = selectedSingleDate
            ? "Selected"
            : isSelectedStart
              ? "Start"
              : isSelectedEnd
                ? "End"
                : isInRange
                  ? "Stay"
                  : "";
          const hasGuests = Boolean(night?.guestCount);
          const overlay = overlayByDate?.[dateString];
          const selectionClass =
            isSelectedStart || isSelectedEnd
              ? "border-4 border-double border-brand-gold bg-brand-gold text-brand-charcoal"
              : isInRange
                ? "border-2 border-dashed border-brand-gold bg-muted text-foreground"
                : overlay
                  ? overlay.emphasis === "ring"
                    ? CALENDAR_TONE_CLASSES[overlay.tone].ringCell
                    : CALENDAR_TONE_CLASSES[overlay.tone].cell
                  : hasGuests
                    ? "border-brand-gold/40 bg-card text-card-foreground hover:bg-muted"
                    : "border-border bg-card text-foreground hover:bg-muted";
          // #2631: name the UNIT in the accessible label. `guestCount` is the
          // NIGHT count, and the overlay beside it can be the operational day,
          // so on a checkout morning a bare "No guests" was read out
          // immediately before "Needs roster" — a screen-reader user got a flat
          // contradiction where a sighted one at least sees two different
          // marks. "No overnight guests" / "N staying overnight" says which of
          // the two numbers this is.
          const guestLabel = night?.guestCount
            ? `${night.guestCount} staying overnight`
            : "No overnight guests";

          return (
            <button
              key={dateString}
              type="button"
              disabled={isPast}
              onClick={() => handleDayClick(dateString)}
              aria-pressed={isSelectedStart || isSelectedEnd || isInRange}
              aria-label={`${formatDisplayDate(dateString)}, ${guestLabel}${isPast ? ", past date" : ""}${overlay ? `, ${overlay.label}` : ""}${selectionLabel ? `, ${selectionLabel.toLowerCase()} selection` : ""}`}
              // Stable hooks for tests/tooling so overlay assertions target the
              // tone + emphasis rather than the token class strings, which the
              // "Restrained Alpine" restyle may re-tint.
              data-overlay-tone={overlay?.tone}
              data-overlay-emphasis={overlay ? (overlay.emphasis ?? "fill") : undefined}
              className={`relative min-h-16 border-b border-r p-1.5 text-left transition-colors disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground ${selectionClass}`}
            >
              <span className="block text-sm font-semibold leading-none">{day}</span>
              {selectionLabel ? (
                <span
                  aria-hidden="true"
                  className="absolute right-1 top-1 rounded border border-current px-1 text-[9px] font-bold uppercase leading-tight"
                >
                  {selectionLabel}
                </span>
              ) : null}
              {hasGuests && (
                <span className={`mt-2 inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ${
                  isSelectedStart || isSelectedEnd
                    ? "bg-brand-charcoal text-brand-snow"
                    : "border border-brand-gold bg-card text-card-foreground"
                }`}>
                  <Users className="mr-1 h-3 w-3" />
                  {night?.guestCount}
                </span>
              )}
              {overlay && (
                <span
                  className={`mt-1 block truncate rounded px-1 py-0.5 text-[10px] font-medium leading-tight ${CALENDAR_TONE_CLASSES[overlay.tone].badge}`}
                >
                  {overlay.label}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="space-y-3 px-3 py-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <span className="h-3 w-3 rounded bg-card ring-1 ring-brand-gold" />
            Guests staying
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-3 w-3 rounded bg-brand-gold" />
            Selected {mode === "single" ? "date" : "range"}
          </span>
          {overlayLegend?.map((item) => (
            <span key={item.label} className="inline-flex items-center gap-1">
              <span className={"h-3 w-3 rounded " + CALENDAR_TONE_CLASSES[item.tone].badge} />
              {item.label}
            </span>
          ))}
        </div>

        <div className="rounded-md border border-border bg-muted p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Who&apos;s at the lodge</h3>
              <p className="text-xs text-muted-foreground">
                {selectedPanelRange
                  ? `${selectedPanelRange.startDate} to ${selectedPanelRange.endDate}`
                  : mode === "single"
                    ? "Select a date to see bookings."
                    : "Select a start and end date to see bookings."}
              </p>
              {/* #2631: this panel and the day colours above measure two
                  different things, and on a changeover morning they read like a
                  contradiction unless each says what it counts. This one counts
                  guest-NIGHTS (who sleeps here); the roster colours count the
                  operational DAY (who is here at any point, including guests
                  who leave before midday), which is what the chore roster
                  covers. Shown only where an operational-day overlay is
                  actually painted — the hut-leader calendar's overlay is
                  night-based, so the sentence would be false there. */}
              {overlayCountsOperationalDay &&
                overlayLegend &&
                overlayLegend.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Counts guest-nights — who sleeps here. The day colours above
                    count who is in the lodge that day, which includes a
                    checkout morning.
                  </p>
                )}
            </div>
            {selectedPanelRange && (
              <Badge variant="outline" className="bg-card">
                {selectedRangeLoading
                  ? "Loading..."
                  : `${selectedGuestCount} guest-night${selectedGuestCount === 1 ? "" : "s"}`}
              </Badge>
            )}
          </div>

          {selectedRangeLoading ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Loading occupancy for this selection...
            </p>
          ) : selectedRangeLoadFailed ? (
            <p className="mt-3 text-sm text-danger">
              Occupancy could not be loaded for this selection.
            </p>
          ) : selectedPanelRange && selectedBookings.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No operational bookings in this selection.</p>
          ) : selectedPanelRange ? (
            <div className="mt-3 divide-y divide-border rounded-md border border-border bg-card">
              {selectedBookings.map((booking) => {
                const isSingleNight =
                  selectedPanelRange.startDate === selectedPanelRange.endDate;
                return (
                  <Link
                    key={booking.id}
                    href={`/bookings/${booking.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-muted"
                  >
                    <span>
                      <span className="font-medium text-foreground">{booking.ownerName}</span>
                      <span className="ml-2 text-xs text-muted-foreground">#{booking.reference}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {booking.checkIn} to {booking.checkOut} - {booking.guestCount}{" "}
                      {isSingleNight ? "guest" : "guest-night"}
                      {booking.guestCount === 1 ? "" : "s"}
                    </span>
                  </Link>
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
