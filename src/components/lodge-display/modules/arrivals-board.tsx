import type {
  DisplayState,
  DisplayStateBooking,
} from "@/lib/lodge-display-state";
import {
  ARRIVALS_BOARD_DEFAULT_DAYS,
  ARRIVALS_BOARD_MAX_NAMES,
  intOption,
  type DisplayPanelOptions,
} from "./module-options";

// The everyday bar board (fork issue #30; visual reference:
// docs/lobby-display/mockups/everyday-bar-board.html). Pure function of the
// privacy-reduced DisplayState payload: room rows (or per-booking rows when
// allocation is off), one continuous bar per booking row across the nights it
// covers, up to N names then "+N", check-out date on each bar. Styling
// attaches via the display stylesheet (LTV-007) through the display-*
// class hooks.

export interface BarLayout {
  startColumn: number; // 1-based grid column within the visible window
  spanColumns: number;
  startsBeforeWindow: boolean;
  endsAfterWindow: boolean;
}

/**
 * Compute a bar's grid placement within the visible window. Exported for
 * direct unit testing — the maths is where clipping bugs live (the mockup
 * iteration caught exactly this class of defect).
 */
export function computeBarLayout(
  row: { stayStart: string; stayEnd: string },
  windowDates: string[]
): BarLayout | null {
  if (windowDates.length === 0) return null;
  const first = windowDates[0];
  const last = windowDates[windowDates.length - 1];
  if (row.stayEnd < first || row.stayStart > last) return null;

  const startIndex = windowDates.findIndex((date) => date >= row.stayStart);
  const clampedStart = startIndex === -1 ? 0 : startIndex;
  let endIndex = windowDates.length - 1;
  for (let i = windowDates.length - 1; i >= 0; i--) {
    if (windowDates[i] <= row.stayEnd) {
      endIndex = i;
      break;
    }
  }

  return {
    startColumn: clampedStart + 1,
    spanColumns: Math.max(1, endIndex - clampedStart + 1),
    startsBeforeWindow: row.stayStart < first,
    endsAfterWindow: row.stayEnd > last,
  };
}

/** "Jane S, Rewi P +2" — up to max names, then an explicit overflow count. */
export function barNames(
  row: DisplayStateBooking,
  maxNames: number
): { names: string[]; overflow: number } {
  if (!row.guests || row.guests.length === 0) {
    return { names: [row.label], overflow: 0 };
  }
  const names = row.guests.slice(0, maxNames).map((guest) => guest.label);
  return { names, overflow: Math.max(0, row.guests.length - names.length) };
}

export function windowDatesOf(state: DisplayState): string[] {
  return state.occupancy.map((day) => day.date);
}

function formatDayHeading(date: string, index: number): string {
  const day = new Date(`${date}T00:00:00`);
  const weekday = day.toLocaleDateString("en-NZ", { weekday: "short" });
  return index === 0 ? `Tonight · ${weekday} ${day.getDate()}` : `${weekday} ${day.getDate()}`;
}

export function ArrivalsBoard({
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
  const windowDates = windowDatesOf(state).slice(0, days);

  const rowGroups: Array<{ heading: string | null; rows: DisplayStateBooking[] }> =
    state.rooms === null
      ? [{ heading: null, rows: state.bookings }]
      : [
          ...state.rooms.map((room) => ({
            heading: room.name,
            rows: state.bookings.filter((row) => row.roomId === room.id),
          })),
          {
            heading: "Unassigned",
            rows: state.bookings.filter((row) => row.roomId === null),
          },
        ].filter((group) => group.rows.length > 0 || group.heading !== "Unassigned");

  return (
    <div className="display-arrivals-board" data-days={windowDates.length}>
      <div className="display-board-head" role="row">
        <span className="display-board-corner" />
        {windowDates.map((date, index) => (
          <span key={date} className="display-board-day" role="columnheader">
            {formatDayHeading(date, index)}
          </span>
        ))}
      </div>
      {rowGroups.map((group, groupIndex) => (
        <div className="display-board-row" key={group.heading ?? `group-${groupIndex}`}>
          {group.heading !== null && (
            <span className="display-board-room" role="rowheader">
              {group.heading}
            </span>
          )}
          <div className="display-board-lanes">
            {group.rows.map((row) => {
              const layout = computeBarLayout(row, windowDates);
              if (!layout) return null;
              const { names, overflow } = barNames(row, maxNames);
              return (
                <div
                  key={row.key}
                  className="display-bar"
                  data-whole-lodge={row.wholeLodge || undefined}
                  data-starts-before={layout.startsBeforeWindow || undefined}
                  data-ends-after={layout.endsAfterWindow || undefined}
                  style={{
                    gridColumnStart: layout.startColumn,
                    gridColumnEnd: `span ${layout.spanColumns}`,
                  }}
                >
                  <span className="display-bar-names">
                    {names.join(", ")}
                    {overflow > 0 && (
                      <span className="display-bar-overflow"> +{overflow}</span>
                    )}
                  </span>
                  <span className="display-bar-out">
                    {layout.endsAfterWindow ? `out ${row.stayEnd} →` : `out ${row.stayEnd}`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
