import type { CSSProperties } from "react";
import type { DisplayState } from "@/lib/lodge-display-state";
import {
  ARRIVALS_BOARD_DEFAULT_DAYS,
  ARRIVALS_BOARD_MAX_NAMES,
  OCCUPANCY_GRID_VARIANTS,
  enumOption,
  intOption,
  type DisplayPanelOptions,
} from "./module-options";
import {
  barMeta,
  barNames,
  computeBarLayout,
  computeBarSegments,
  splitRoomName,
  windowDatesOf,
} from "./arrivals-board";
import { DISPLAY_SHORT_WEEKDAY } from "./status-helpers";
import { APP_LOCALE, APP_TIME_ZONE } from "@/config/operational";

// The whole-lodge blockout view (fork issues #30/#58; visual references:
// docs/lobby-display/mockups/approved/whole-lodge.html options A/C and
// whole-lodge-rotating.html). When a group has the lodge to itself the
// serialiser has already withheld individual names (issue #28 AC3) — this
// module renders the group label only:
//
// - rooms configured → the BOARD variant: day headers and dimmed room labels
//   stay (any member walking past still reads it as the booking board), and
//   a block panel spans the booked nights. Part-week bookings block only
//   their columns; other bookings render as normal bars in the free columns
//   and their room labels light back up (mock option C).
// - no rooms → the STATEMENT variant (mock option B): a full-width block
//   statement plus a week occupancy strip showing when the lodge frees.

// Not shared `nzst-date` shapes (#2264): the blockout statement drops the YEAR
// from both its date forms, because a lobby screen only ever names dates inside
// the current stay window and the year would be noise on the wall. Zones pinned
// to club time; the short form's weekday half is the one shared display
// constant. See `status-helpers.DISPLAY_SHORT_WEEKDAY`.
const DISPLAY_SHORT_DATE = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIME_ZONE,
  weekday: "short",
  day: "numeric",
  month: "short",
});

const DISPLAY_LONG_DATE = new Intl.DateTimeFormat(APP_LOCALE, {
  timeZone: APP_TIME_ZONE,
  weekday: "long",
  day: "numeric",
  month: "long",
});

// Every date below is an NZ date-only lodge night handed over at UTC midnight
// rather than parsed in the browser's own zone (#2264) — see
// `status-helpers.shortDay` for why the bare `T00:00:00` parse was wrong.
function shortDate(date: string): string {
  return DISPLAY_SHORT_DATE.format(new Date(`${date}T00:00:00Z`));
}

function longDate(date: string): string {
  return DISPLAY_LONG_DATE.format(new Date(`${date}T00:00:00Z`));
}

function weekday(date: string): string {
  return DISPLAY_SHORT_WEEKDAY.format(new Date(`${date}T00:00:00Z`));
}

function formatDayHeading(date: string, index: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  const label = `${DISPLAY_SHORT_WEEKDAY.format(day)} ${day.getUTCDate()}`;
  return index === 0 ? `Tonight · ${label}` : label;
}

function BlockPanel({
  row,
  note,
  variant,
}: {
  row: { label: string; guestCount: number; stayStart: string; stayEnd: string };
  note: string | null;
  variant: "board" | "statement";
}) {
  return (
    <>
      <span className="display-blockout-kicker">
        {variant === "statement" ? "The lodge is fully booked" : "Whole lodge booked"}
      </span>
      <span className="display-blockout-label">{row.label}</span>
      <span className="display-blockout-sub">{row.guestCount} guests</span>
      <span className="display-blockout-dates">
        {variant === "statement"
          ? `${longDate(row.stayStart)} → ${longDate(row.stayEnd)}`
          : `${shortDate(row.stayStart)} → ${shortDate(row.stayEnd)} · reopens ${weekday(row.stayEnd)}`}
      </span>
      {note && <span className="display-blockout-note">{note}</span>}
    </>
  );
}

export function OccupancyGrid({
  state,
  options,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  const days = intOption(options, "days", ARRIVALS_BOARD_DEFAULT_DAYS, {
    min: 1,
    max: 7,
  });
  const maxNames = intOption(options, "max-names", ARRIVALS_BOARD_MAX_NAMES, {
    min: 1,
    max: 10,
  });
  // `variant`: "auto" (board when rooms exist, else statement) or force one.
  // "statement" gives the summary + week-strip look (mock B1b) even for a lodge
  // that has rooms; "board" only draws when rooms exist (else it degrades to the
  // statement, which needs no room axis).
  const variant = enumOption(options, "variant", "auto", OCCUPANCY_GRID_VARIANTS);
  const windowDates = windowDatesOf(state).slice(0, days);
  const wholeLodgeRow = state.bookings.find((row) => row.wholeLodge) ?? null;
  const note = state.config["whole-lodge-note"] ?? null;

  // Defensive fallback — the notice condition normally keeps this panel off
  // screen without a whole-lodge booking, but never render broken.
  if (!wholeLodgeRow || windowDates.length === 0) {
    return (
      <div className="display-occupancy-grid display-blockout-statement">
        <span className="display-blockout-label">{state.lodge.name}</span>
      </div>
    );
  }

  // --- statement variant: no rooms to draw, or forced (B1b) ----------------
  if (
    variant === "statement" ||
    state.rooms === null ||
    state.rooms.length === 0
  ) {
    const maxStaying = Math.max(1, ...state.occupancy.map((day) => day.staying));
    // The blockout panel spans the whole-lodge row's ENVELOPE, deliberately —
    // not its segments (#2735). It carries the kicker, the group label, the
    // headcount, the dates and the note, so it is one panel per blockout by
    // construction; splitting it would print that block twice. A whole-lodge
    // hold is a contiguous exclusive hold, so the two spans are the same span.
    const blockLayout = computeBarLayout(wholeLodgeRow, windowDates);
    return (
      <div className="display-occupancy-grid display-blockout-statement">
        <BlockPanel row={wholeLodgeRow} note={note} variant="statement" />
        <div className="display-week-strip" role="row">
          {state.occupancy.map((day, index) => {
            const blocked =
              blockLayout !== null &&
              index + 1 >= blockLayout.startColumn &&
              index + 1 < blockLayout.startColumn + blockLayout.spanColumns;
            return (
              <span
                key={day.date}
                className="display-week-day"
                data-today={index === 0 || undefined}
              >
                <span className="display-week-name">{weekday(day.date)}</span>
                <span className="display-week-bar">
                  <span
                    data-blocked={blocked || undefined}
                    style={{ width: `${Math.round((day.staying / maxStaying) * 100)}%` }}
                  />
                </span>
                <span className="display-week-count">{day.staying}</span>
              </span>
            );
          })}
        </div>
      </div>
    );
  }

  // --- board variant: grid chrome + block spanning the booked nights -------
  // Envelope, not segments — same reason as the statement variant above.
  const blockLayout = computeBarLayout(wholeLodgeRow, windowDates);
  const rooms = state.rooms;
  const roomsWithBars = new Set(
    state.bookings
      .filter((row) => !row.wholeLodge && row.roomId !== null)
      .filter((row) => computeBarSegments(row, windowDates).length > 0)
      .map((row) => row.roomId)
  );

  return (
    <div
      className="display-blockout-board"
      style={
        {
          "--display-days": windowDates.length,
          "--display-block-rooms": rooms.length,
        } as CSSProperties
      }
    >
      <span className="display-board-corner display-blockout-head">Room</span>
      {windowDates.map((date, index) => (
        <span
          key={date}
          className="display-board-day display-blockout-head"
          data-today={index === 0 || undefined}
          style={{ gridColumn: index + 2 }}
        >
          {formatDayHeading(date, index)}
        </span>
      ))}
      {rooms.map((room, index) => {
        const split = splitRoomName(room.name);
        return (
          <span
            key={room.id}
            className="display-board-room"
            data-live={roomsWithBars.has(room.id) || undefined}
            style={{ gridRow: index + 2 }}
          >
            {split.tag && <span className="display-board-room-tag">{split.tag}</span>}
            {split.label}
          </span>
        );
      })}
      {rooms.map((room, index) => (
        <span
          key={`cells-${room.id}`}
          className="display-blockout-cells"
          style={{ gridRow: index + 2, gridColumn: "2 / -1" }}
        />
      ))}
      {/* Other bookings keep their normal bars in the unblocked columns
          (part-week, mock option C). Rows without a room can't be placed. */}
      {state.bookings
        .filter((row) => !row.wholeLodge && row.roomId !== null)
        .flatMap((row) => {
          const roomIndex = rooms.findIndex((room) => room.id === row.roomId);
          if (roomIndex === -1) return [];
          const { names, overflow } = barNames(row, maxNames);
          // One bar per contiguous run of the row's nights (#2735), same as the
          // everyday board — a part-week booking beside a blockout can have a
          // gap in it too.
          return computeBarSegments(row, windowDates).map((layout, segmentIndex) => (
            <div
              key={`${row.key}-${segmentIndex}`}
              className="display-bar"
              data-group={row.guests === null || undefined}
              data-departing={layout.departing || undefined}
              style={{
                gridRow: roomIndex + 2,
                gridColumnStart: layout.startColumn + 1,
                gridColumnEnd: `span ${layout.spanColumns}`,
              }}
            >
              <span className="display-bar-names">
                {row.guests === null ? `${row.label} · ${row.guestCount}` : names.join(", ")}
                {overflow > 0 && (
                  <span className="display-bar-overflow"> +{overflow}</span>
                )}
              </span>
              <span className="display-bar-out">{barMeta(layout)}</span>
            </div>
          ));
        })}
      {blockLayout && (
        <div
          className="display-blockout-panel"
          style={{
            gridRow: "2 / -1",
            gridColumnStart: blockLayout.startColumn + 1,
            gridColumnEnd: `span ${blockLayout.spanColumns}`,
          }}
        >
          <BlockPanel row={wholeLodgeRow} note={note} variant="board" />
        </div>
      )}
    </div>
  );
}
