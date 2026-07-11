import type { DisplayState } from "../lodge-display-state";

// Rotation eligibility conditions for lobby display panels (fork issue #29,
// ADR-002 §3): a fixed named set, each a PURE function of the DisplayState
// payload — no queries, no side effects — so a screen never rotates into a
// view that is wrong for the current data. A general expression language was
// deliberately deferred (brief open question 3).

export const DISPLAY_CONDITION_NAMES = [
  "always",
  "whole-lodge-booking-in-window",
  "arrivals-today",
  "no-guests",
] as const;

export type DisplayConditionName = (typeof DISPLAY_CONDITION_NAMES)[number];

const CONDITIONS: Record<DisplayConditionName, (state: DisplayState) => boolean> = {
  always: () => true,
  "whole-lodge-booking-in-window": (state) =>
    state.bookings.some((booking) => booking.wholeLodge),
  "arrivals-today": (state) => (state.occupancy[0]?.arriving ?? 0) > 0,
  "no-guests": (state) =>
    state.occupancy.every((day) => day.staying === 0),
};

export function isDisplayConditionName(
  name: string
): name is DisplayConditionName {
  return (DISPLAY_CONDITION_NAMES as readonly string[]).includes(name);
}

export function evaluateDisplayCondition(
  name: DisplayConditionName,
  state: DisplayState
): boolean {
  return CONDITIONS[name](state);
}
