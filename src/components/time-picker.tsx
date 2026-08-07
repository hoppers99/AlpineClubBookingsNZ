"use client";

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
  /**
   * Last-resort accessible name for a caller with no visible label to point at.
   * Prefer `id` + a real `<label>`: a visible label helps everyone, and an
   * `aria-label` that drifts from nearby visible text is worse than none.
   */
  ariaLabel?: string;
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
      const suffix = h >= 12 ? "PM" : "AM";
      const displayHour = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const label = `${displayHour}:${String(m).padStart(2, "0")} ${suffix}`;
      options.push({ value, label });
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
  ariaLabel,
}: TimePickerProps) {
  return (
    <select
      id={id}
      aria-describedby={describedBy}
      aria-label={ariaLabel}
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
