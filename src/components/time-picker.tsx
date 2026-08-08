"use client";

import { formatArrivalTime } from "@/lib/arrival-time";

interface TimePickerProps {
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  /**
   * #2621 — the id of the rendered `<select>`.
   *
   * Without it this component rendered an unlabelled form control: a caller
   * could put a visible heading or a `<label>` next to the picker, but nothing
   * connected the two, so a screen reader announced only "combo box" and the
   * label's click target did nothing. The control is what carries the
   * accessible name, so the id has to be settable from outside — the caller
   * owns both halves of `<label htmlFor>` / `id` and is the only place that can
   * guarantee they match.
   */
  id?: string;
  /**
   * The id(s) of the element(s) holding the picker's help text, forwarded to
   * `aria-describedby`. Description is separate from name on purpose: "Expected
   * arrival time" is the name, "roughly when you expect to reach the lodge" is
   * the description, and folding the second into the first makes every
   * announcement of the field read the whole sentence again.
   */
  describedBy?: string;
}

function generateTimeOptions(): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = [];
  // 06:00–23:00. Deliberately NARROWER than the API's accepted range
  // (00:00–23:30, `ARRIVAL_TIME_PATTERN`): this is the plausible span for
  // arriving at the lodge, while the API stays honest about the genuinely
  // after-midnight arrival. See src/lib/arrival-time.ts.
  for (let h = 6; h <= 23; h++) {
    for (const m of [0, 30]) {
      if (h === 23 && m === 30) continue;
      const value = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      // #2621: labelled by the SHARED formatter, not a private copy of the same
      // arithmetic. This component held the fourth hand-rolled 12-hour renderer
      // in the codebase, so the option a member picks and the value their booking
      // page, the kiosk and the lobby wall read back could drift apart one edit
      // at a time. `@/lib/arrival-time` imports nothing, so using it here pulls
      // no extra weight into this client bundle.
      options.push({ value, label: formatArrivalTime(value) });
    }
  }
  return options;
}

const TIME_OPTIONS = generateTimeOptions();

export function TimePicker({
  value,
  onChange,
  disabled,
  id,
  describedBy,
}: TimePickerProps) {
  return (
    <select
      id={id}
      aria-describedby={describedBy}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      disabled={disabled}
      className="block w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
    >
      <option value="">Not sure</option>
      {TIME_OPTIONS.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
