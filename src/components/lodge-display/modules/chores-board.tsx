import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayPanelOptions } from "./module-options";

// The day's chore list (fork issue #31): renders DisplayState.chores exactly
// as the privacy serialiser provided them — assignee labels are already
// reduced (a minor's chore carries the family/group label, issue #28), and
// this module never re-derives names from any other source (issue #31 AC1).

export function ChoresBoard({
  state,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  const byDate = new Map<string, DisplayState["chores"]>();
  for (const chore of state.chores) {
    const list = byDate.get(chore.date) ?? [];
    list.push(chore);
    byDate.set(chore.date, list);
  }

  return (
    <div className="display-chores-board">
      {byDate.size === 0 && (
        <span className="display-chores-empty">No chores assigned</span>
      )}
      {[...byDate.entries()].map(([date, chores]) => (
        <div key={date} className="display-chores-day">
          <span className="display-chores-date">{date}</span>
          <ul className="display-chores-list">
            {chores.map((chore, index) => (
              <li key={`${date}-${index}`} className="display-chore">
                <span className="display-chore-title">{chore.title}</span>
                {chore.assigneeLabels.length > 0 && (
                  <span className="display-chore-assignees">
                    {chore.assigneeLabels.join(", ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
