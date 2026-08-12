/**
 * HOW BIG THE HELP PANEL IS, AND WHO DECIDES (AID-7, #2378, owner decision D8).
 *
 * The panel has always been one fixed size: 24rem wide and 70vh tall on a desktop,
 * a near-full-height sheet on a phone. That is comfortable for a help answer and
 * genuinely tight for a Diagnostics one, which can carry several blocker codes plus
 * the evidence it read them from. Since the owner's decision put ALL asking in this
 * panel rather than on a page, the panel has to be able to grow.
 *
 * PRESETS, NOT A DRAG HANDLE — and that is the accessibility requirement, not a
 * preference. The owner asked whether it could be drag-expandable. It can, and drag
 * may be added on top of this, but a drag handle alone is reachable only with a
 * mouse: no keyboard path, nothing for a screen reader to announce, and a fine motor
 * gesture where a button would do. #2378 requires keyboard-only and screen-reader
 * operation as first-class. Presets are also simply better here — one key to "make
 * this big" beats a careful drag — so they are the primary control rather than a
 * fallback bolted beside one.
 *
 * THE SIZES ARE CSS CLASSES, NOT NUMBERS, because Tailwind needs the class names to
 * exist in the source to emit them; a computed `sm:w-[${n}rem]` produces a class
 * that was never built and the panel silently keeps its old width.
 *
 * MOBILE IS DELIBERATELY UNCHANGED. The panel is already a bottom sheet at 85dvh
 * there, so "tall" and "full screen" have almost nothing left to give, and a
 * viewport-sized floating panel on a phone is just a page that cannot be scrolled
 * past. Every preset therefore differs only from the `sm:` breakpoint up.
 */

/** The sizes an operator can choose. Ordered smallest to largest. */
export const HELP_PANEL_SIZES = ["comfortable", "tall", "full"] as const;

export type HelpPanelSize = (typeof HELP_PANEL_SIZES)[number];

/** The size the panel opens at when the operator has never chosen one. */
export const DEFAULT_HELP_PANEL_SIZE: HelpPanelSize = "comfortable";

/**
 * Where the choice is remembered.
 *
 * `localStorage`, so it survives a reload and follows the operator around the admin
 * panel. It is UI preference and nothing else — no answer, no question, no evidence
 * and no identifier is stored, which matters because this product reads personal
 * data and its transcript is deliberately memory-only.
 */
export const HELP_PANEL_SIZE_STORAGE_KEY = "tac.help-panel-size";

/** Operator-facing label for each size. Used on the control and announced. */
export const HELP_PANEL_SIZE_LABELS: Record<HelpPanelSize, string> = {
  comfortable: "Comfortable",
  tall: "Tall",
  full: "Full screen",
};

/**
 * The panel's geometry classes for each size.
 *
 * Only the `sm:` half varies — see the mobile note above. Written out in full rather
 * than composed, so every class name is literally present for Tailwind to find.
 */
export const HELP_PANEL_SIZE_CLASSES: Record<HelpPanelSize, string> = {
  comfortable: "sm:w-[24rem] sm:max-h-[70vh]",
  tall: "sm:w-[28rem] sm:max-h-[90vh]",
  // Full screen still leaves the viewport's own padding, so the panel never sits
  // flush against the edges where a browser's own chrome overlaps it.
  full: "sm:inset-4 sm:w-auto sm:max-h-none sm:h-auto",
};

/** Is this a size the panel knows how to render? */
export function isHelpPanelSize(value: unknown): value is HelpPanelSize {
  return (
    typeof value === "string" &&
    (HELP_PANEL_SIZES as readonly string[]).includes(value)
  );
}

/**
 * The next size in the cycle, so one control can step through all three.
 *
 * A cycle rather than three buttons: three buttons in a header that already holds a
 * title and a close button is clutter, and the operator's actual intent is "bigger"
 * — which one predictable key press satisfies. It WRAPS from full back to
 * comfortable so there is always a way back without hunting for a different control.
 */
export function nextHelpPanelSize(current: HelpPanelSize): HelpPanelSize {
  const index = HELP_PANEL_SIZES.indexOf(current);
  return HELP_PANEL_SIZES[(index + 1) % HELP_PANEL_SIZES.length];
}

/**
 * Read the remembered size, falling back to the default.
 *
 * Never throws. `localStorage` throws in a sandboxed iframe and when a browser is
 * configured to block storage, and a help panel that cannot open because it could
 * not read a cosmetic preference would be a genuinely bad trade.
 */
export function readStoredHelpPanelSize(): HelpPanelSize {
  if (typeof window === "undefined") return DEFAULT_HELP_PANEL_SIZE;
  try {
    const stored = window.localStorage.getItem(HELP_PANEL_SIZE_STORAGE_KEY);
    return isHelpPanelSize(stored) ? stored : DEFAULT_HELP_PANEL_SIZE;
  } catch {
    return DEFAULT_HELP_PANEL_SIZE;
  }
}

/** Remember the size. Silent on failure, for the same reason as the read. */
export function storeHelpPanelSize(size: HelpPanelSize): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HELP_PANEL_SIZE_STORAGE_KEY, size);
  } catch {
    // Preference not remembered. The panel still works at the chosen size for
    // this session, which is the part that matters.
  }
}
