/**
 * The expected arrival time a member may record on a booking — the ONE
 * definition of what that value may be and how it reads.
 *
 * #2621 (epic #2629, owner decision 8 Aug): the field is **display-only
 * information**. It tells a hut leader roughly when to expect people, on the
 * kiosk and on the lodge display wall. It drives NOTHING: it is not part of the
 * stay boundary, it does not decide presence, and it never feeds the chore
 * allocator — the midday-to-midday operational day (#2622/#2631) is the only
 * thing that does. Nothing here may grow a consumer that changes an outcome.
 *
 * WHY THIS MODULE EXISTS. The accepted-value rule used to be a regex literal
 * copied into three places — the booking-create schema, the arrival-time route,
 * and a test that RE-IMPLEMENTED it rather than importing it. All three copies
 * read `[0-5]0`, which accepts `:10`, `:20`, `:40` and `:50` while every error
 * message and the only picker in the product said 30-minute increments. The
 * test could not catch it because it asserted against its own copy of the same
 * wrong pattern. One exported pattern, imported everywhere including the test,
 * is what makes that class of drift impossible rather than merely unlikely.
 *
 * This module deliberately imports NOTHING (not even zod): the formatter runs
 * in client components — the booking editor, the kiosk, the lobby wall — and
 * must not pull a validation library into those bundles. Route schemas compose
 * `ARRIVAL_TIME_PATTERN` into their own `z.string().regex(...)`.
 */

/**
 * `HH:00` or `HH:30`, 00:00 through 23:30 — the canonical 30-minute set.
 *
 * The minute alternation is spelled `(00|30)` and NOT `[0-5]0`: the old form
 * silently accepted `:10/:20/:40/:50`, so a hand-rolled or scripted request
 * could store a time the picker can never round-trip and the member could never
 * see selected again.
 *
 * THE HOUR RANGE IS WIDER THAN THE PICKER, ON PURPOSE. `TimePicker` offers
 * 06:00–23:00, because that is the plausible span for arriving at an alpine
 * lodge. The API accepts the whole day, 00:00–23:30, because a genuine
 * after-midnight arrival is a real thing in this club and an API that rejected
 * `01:30` would be rejecting the truth. Widening the picker or narrowing the
 * API are both real product decisions; neither is implied by the other, and the
 * difference is documented here so a future reader does not "tidy" one into the
 * other by accident.
 */
export const ARRIVAL_TIME_PATTERN = /^([01]\d|2[0-3]):(00|30)$/;

/**
 * The message a member sees when the value is refused. It must describe the
 * pattern above ACCURATELY — the previous text promised "30-minute increments"
 * over a pattern that accepted six other minute values, so the API's contract
 * and its stated contract disagreed.
 */
export const ARRIVAL_TIME_ERROR_MESSAGE =
  "Must be a time on the hour or half hour, as HH:mm (for example 17:00 or 17:30)";

/** Whether `value` is an acceptable expected arrival time. */
export function isValidArrivalTime(value: string): boolean {
  return ARRIVAL_TIME_PATTERN.test(value);
}

/**
 * Any 24-hour wall-clock time, to ANY minute — `00:00` through `23:59`.
 *
 * Deliberately wider than `ARRIVAL_TIME_PATTERN`, and used only by the
 * formatter. What may be STORED from today on is the canonical half-hour set;
 * what may have to be DISPLAYED includes every `:10`/`:15`/`:47` value the old
 * `[0-5]0` pattern (and hand-written SQL before it) let through. Those rows
 * exist, they are perfectly readable times, and a member looking at one is
 * entitled to see it in the same 12-hour form as everyone else.
 */
const DISPLAYABLE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * `"17:30"` → `"5:30 PM"`. The one 12-hour rendering of the field, shared by
 * the booking page editor, the lodge kiosk, the picker's own option labels and
 * the lobby wall, so four surfaces cannot describe one stored value four ways.
 *
 * No time zone is involved and none may be introduced: the stored value is a
 * bare wall-clock time at the lodge, not an instant, so it is never parsed into
 * a `Date` (which would attach the viewer's zone to it and shift it).
 *
 * WHAT IT ACCEPTS, AND WHY IT IS WIDER THAN THE VALIDATOR. Every real
 * `HH:mm` — any minute, not just `:00`/`:30`. A legacy `"14:10"` renders
 * `"2:10 PM"`, exactly as the per-surface formatters this module replaced always
 * did; returning it raw would have been a REGRESSION dressed as caution, showing
 * one member a 24-hour string beside everyone else's 12-hour one. The minutes
 * are numeric by construction, so there was never a `NaN:NaN` to fear here —
 * only unparseable non-time text, and that alone is returned unchanged (a
 * corrupt row shows as itself rather than as a confidently wrong time).
 *
 * Note that the LOBBY WALL is stricter still: `lodge-display-state` refuses to
 * put a non-canonical value into the public payload at all, so this tolerance
 * never widens what an unauthenticated screen prints. That filter is deliberate
 * and documented there; this formatter's tolerance is about the member's own
 * booking page and the hut leader's kiosk, where the row's real stored value is
 * the truth being shown.
 */
export function formatArrivalTime(time: string): string {
  if (!DISPLAYABLE_TIME_PATTERN.test(time)) return time;
  const [hours, minutes] = time.split(":");
  const hour = Number(hours);
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 === 0 ? 12 : hour % 12;
  return `${displayHour}:${minutes} ${suffix}`;
}
