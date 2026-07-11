import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayPanelOptions } from "./module-options";

// The by-booking singles board (fork issue #30; visual reference:
// docs/lobby-display/mockups/singles-by-booking.html): a two-column
// Room | Guest listing where every guest keeps their own check-out date.
// Renders rows grouped by booking; used when allocation is per-person
// (DisplayState.rooms null → the room column collapses; issue #30 AC4).

export function SinglesBoard({
  state,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  const roomName = (roomId: string | null): string | null => {
    if (state.rooms === null || roomId === null) return null;
    return state.rooms.find((room) => room.id === roomId)?.name ?? null;
  };

  return (
    <div
      className="display-singles-board"
      data-has-rooms={state.rooms !== null || undefined}
    >
      {state.bookings.map((row) => {
        const room = roomName(row.roomId);
        // Counts-only / family / org rows keep their reduced label.
        const entries =
          row.guests?.map((guest) => ({
            key: `${row.key}-${guest.label}-${guest.stayEnd}`,
            label: guest.label,
            out: guest.stayEnd,
          })) ?? [
            { key: row.key, label: `${row.label} · ${row.guestCount}`, out: row.stayEnd },
          ];
        return entries.map((entry) => (
          <div key={entry.key} className="display-singles-row">
            {state.rooms !== null && (
              <span className="display-singles-room">{room ?? "—"}</span>
            )}
            <span className="display-singles-guest">{entry.label}</span>
            <span className="display-singles-out">out {entry.out}</span>
          </div>
        ));
      })}
    </div>
  );
}
