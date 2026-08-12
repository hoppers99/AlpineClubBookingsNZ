// @vitest-environment jsdom

/**
 * Help panel sizing (AID-7, #2378, owner decision D8) — the rules, without React.
 *
 * The panel became resizable because the owner's decision put ALL Diagnostics asking
 * into it, and 24rem is tight for an answer carrying several blocker codes plus the
 * evidence it read them from. These tests cover the rules that decision rests on; the
 * rendered control and its keyboard reachability are covered in the widget's own
 * component test.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_HELP_PANEL_SIZE,
  HELP_PANEL_SIZES,
  HELP_PANEL_SIZE_CLASSES,
  HELP_PANEL_SIZE_LABELS,
  HELP_PANEL_SIZE_STORAGE_KEY,
  isHelpPanelSize,
  nextHelpPanelSize,
  readStoredHelpPanelSize,
  storeHelpPanelSize,
} from "../help-widget-size";

afterEach(() => {
  vi.unstubAllGlobals();
  try {
    window.localStorage.clear();
  } catch {
    // Nothing stored; nothing to clear.
  }
});

describe("the panel's sizes (#2378 D8)", () => {
  it("opens at the size it always had, so nothing changes for a help user", () => {
    // The panel is shared with Page Help. Diagnostics needed it to GROW; it did not
    // need every help reader's panel to start bigger.
    expect(DEFAULT_HELP_PANEL_SIZE).toBe("comfortable");
    expect(HELP_PANEL_SIZE_CLASSES.comfortable).toContain("sm:w-[24rem]");
    expect(HELP_PANEL_SIZE_CLASSES.comfortable).toContain("sm:max-h-[70vh]");
  });

  it("cycles through every size and wraps, so there is always a way back", () => {
    // A cycle with no wrap is a trap: an operator who reaches the largest size has
    // no control left to make it smaller again.
    const seen = new Set<string>();
    let size = DEFAULT_HELP_PANEL_SIZE;
    for (let step = 0; step < HELP_PANEL_SIZES.length; step += 1) {
      seen.add(size);
      size = nextHelpPanelSize(size);
    }
    expect(seen.size).toBe(HELP_PANEL_SIZES.length);
    expect(size).toBe(DEFAULT_HELP_PANEL_SIZE);
  });

  it("gives every size real geometry and a label, with none left behind", () => {
    // A size in the list with no classes renders as "whatever the last one was",
    // which looks like the control did nothing.
    for (const size of HELP_PANEL_SIZES) {
      expect(HELP_PANEL_SIZE_CLASSES[size]?.length ?? 0).toBeGreaterThan(0);
      expect(HELP_PANEL_SIZE_LABELS[size]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("only varies from the sm: breakpoint up, leaving phones alone", () => {
    // On a phone the panel is already an 85dvh bottom sheet, so "tall" has almost
    // nothing to give and a viewport-sized floating panel is just a page you cannot
    // scroll past. Every class here must therefore be breakpoint-scoped.
    for (const size of HELP_PANEL_SIZES) {
      const classes = HELP_PANEL_SIZE_CLASSES[size].split(/\s+/);
      for (const className of classes) {
        expect(className, `${size}: "${className}" applies below sm:`).toMatch(
          /^sm:/,
        );
      }
    }
  });

  it("writes class names literally, because a computed one is never built", () => {
    // Tailwind emits only the classes it can find in the source. A template like
    // `sm:w-[${n}rem]` produces a class that does not exist and the panel silently
    // keeps its old width — visible to nobody until someone tries it.
    for (const size of HELP_PANEL_SIZES) {
      expect(HELP_PANEL_SIZE_CLASSES[size]).not.toContain("${");
    }
  });
});

describe("remembering the choice (#2378 D8)", () => {
  it("round-trips a chosen size", () => {
    storeHelpPanelSize("tall");
    expect(readStoredHelpPanelSize()).toBe("tall");
  });

  it("falls back to the default for anything it does not recognise", () => {
    window.localStorage.setItem(HELP_PANEL_SIZE_STORAGE_KEY, "enormous");
    expect(readStoredHelpPanelSize()).toBe(DEFAULT_HELP_PANEL_SIZE);
    expect(isHelpPanelSize("enormous")).toBe(false);
    expect(isHelpPanelSize(null)).toBe(false);
  });

  it("NEVER throws when storage is unavailable", () => {
    // `localStorage` throws in a sandboxed iframe and when a browser blocks storage.
    // A help panel that fails to open because it could not read a cosmetic
    // preference would be a genuinely bad trade, so both paths swallow.
    vi.stubGlobal("localStorage", {
      getItem() {
        throw new Error("storage disabled");
      },
      setItem() {
        throw new Error("storage disabled");
      },
    });

    expect(() => readStoredHelpPanelSize()).not.toThrow();
    expect(readStoredHelpPanelSize()).toBe(DEFAULT_HELP_PANEL_SIZE);
    expect(() => storeHelpPanelSize("full")).not.toThrow();
  });

  it("stores a preference and nothing else", () => {
    // The transcript is deliberately memory-only and this product reads personal
    // data. The one key it writes must stay a cosmetic preference.
    storeHelpPanelSize("full");
    expect(window.localStorage.getItem(HELP_PANEL_SIZE_STORAGE_KEY)).toBe("full");
    expect(window.localStorage.length).toBe(1);
  });
});
