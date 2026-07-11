import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayPanelOptions } from "./module-options";

// The rotating welcome panel (fork issue #30; visual reference:
// docs/lobby-display/mockups/whole-lodge-rotating.html): a warm counterpart
// to the operational boards. Greets the current whole-lodge group by its
// (privacy-reduced) label, or the lodge generally.

export function WelcomePanel({
  state,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  const wholeLodgeRow = state.bookings.find((row) => row.wholeLodge) ?? null;
  const checkinNote = state.config["checkin-note"] ?? null;

  return (
    <div className="display-welcome">
      <span className="display-welcome-kicker">Welcome to {state.lodge.name}</span>
      {wholeLodgeRow && (
        <span className="display-welcome-group">{wholeLodgeRow.label}</span>
      )}
      {checkinNote && <span className="display-welcome-note">{checkinNote}</span>}
    </div>
  );
}
