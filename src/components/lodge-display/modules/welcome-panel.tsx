import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayPanelOptions } from "./module-options";
import { DISPLAY_SHORT_WEEKDAY } from "./status-helpers";

// The rotating welcome panel (fork issues #30/#58; visual reference:
// docs/lobby-display/mockups/approved/whole-lodge-rotating.html panel B): a
// warm counterpart to the operational boards. Greets the current whole-lodge
// group by its (privacy-reduced) label with the mock's info tiles — group
// size, stay dates and nights, and an optional bunks note — or greets the
// lodge generally when no group holds it.

function shortDate(date: string): string {
  // Same terse column-head shape as every other display module, from the one
  // shared constant, and handed over at UTC midnight rather than parsed in the
  // browser's own zone (#2264) — see `status-helpers.shortDay`.
  const day = new Date(`${date}T00:00:00Z`);
  return `${DISPLAY_SHORT_WEEKDAY.format(day)} ${day.getUTCDate()}`;
}

function nightsBetween(start: string, end: string): number {
  const a = new Date(`${start}T00:00:00Z`).getTime();
  const b = new Date(`${end}T00:00:00Z`).getTime();
  return Math.max(1, Math.round((b - a) / 86_400_000));
}

export function WelcomePanel({
  state,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  const wholeLodgeRow = state.bookings.find((row) => row.wholeLodge) ?? null;
  const checkinNote = state.config["checkin-note"] ?? null;
  const bunksNote = state.config["whole-lodge-note"] ?? null;

  return (
    <div className="display-welcome">
      <span className="display-welcome-kicker">Welcome to {state.lodge.name}</span>
      {wholeLodgeRow && (
        <span className="display-welcome-group">{wholeLodgeRow.label}</span>
      )}
      {checkinNote && <span className="display-welcome-note">{checkinNote}</span>}
      {wholeLodgeRow && (
        <div className="display-welcome-tiles">
          <span className="display-welcome-tile">
            <span className="display-tile-key">Group</span>
            <span className="display-tile-value">
              {wholeLodgeRow.guestCount} <small>guests</small>
            </span>
          </span>
          <span className="display-welcome-tile">
            <span className="display-tile-key">Staying</span>
            <span className="display-tile-value">
              {shortDate(wholeLodgeRow.stayStart)} → {shortDate(wholeLodgeRow.stayEnd)}{" "}
              <small>
                · {nightsBetween(wholeLodgeRow.stayStart, wholeLodgeRow.stayEnd)} nights
              </small>
            </span>
          </span>
          {bunksNote && (
            <span className="display-welcome-tile">
              <span className="display-tile-key">Bunks</span>
              <span className="display-tile-value">{bunksNote}</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
