import type { DisplayPanelOptionValue } from "@/lib/lodge-display/template-registry";

// Per-module option parsing for the lobby display (fork issue #30). Every
// module renders sensibly with zero options; an invalid value falls back to
// its documented default rather than throwing (issue #30 AC6) — a bad
// template edit can make a screen plainer, never blank.

export type DisplayPanelOptions = Record<string, DisplayPanelOptionValue>;

export function intOption(
  options: DisplayPanelOptions | undefined,
  key: string,
  fallback: number,
  bounds: { min: number; max: number }
): number {
  const raw = options?.[key];
  const value =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.floor(value)));
}

export const ARRIVALS_BOARD_DEFAULT_DAYS = 3;
export const ARRIVALS_BOARD_MAX_NAMES = 5;
