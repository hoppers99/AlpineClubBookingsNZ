import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayPanelOptions } from "./module-options";

// The whole-lodge blockout view (fork issue #30; visual reference:
// docs/lobby-display/mockups/whole-lodge.html): when a group has the lodge to
// itself, the board shows the group label only — never individual names (the
// serialiser has already withheld them; issue #28 AC3).

export function OccupancyGrid({
  state,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  const wholeLodgeRow = state.bookings.find((row) => row.wholeLodge) ?? null;

  return (
    <div className="display-occupancy-grid">
      {wholeLodgeRow ? (
        <div className="display-blockout">
          <span className="display-blockout-kicker">Whole lodge booked</span>
          <span className="display-blockout-label">{wholeLodgeRow.label}</span>
          <span className="display-blockout-detail">
            {wholeLodgeRow.guestCount} guests · until {wholeLodgeRow.stayEnd}
          </span>
        </div>
      ) : (
        <div className="display-blockout display-blockout-empty">
          <span className="display-blockout-label">{state.lodge.name}</span>
        </div>
      )}
      <div className="display-occupancy-strip" role="row">
        {state.occupancy.map((day) => (
          <span key={day.date} className="display-occupancy-day">
            <span className="display-occupancy-date">{day.date}</span>
            <span className="display-occupancy-count">{day.staying}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
