// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { TimePicker } from "@/components/time-picker";
import {
  ARRIVAL_TIME_MINUTES,
  formatArrivalTime,
  isValidArrivalTime,
} from "@/lib/arrival-time";

/*
  #2621 — the control and the rule must agree, proven by running BOTH.

  The defect was not that either side was wrong on its own. The picker had always
  offered only `:00` and `:30`; the API accepted six minute values; and the test
  that should have caught the gap re-implemented the API's regex, so it agreed
  with the bug and no amount of running it could have said so. Three statements of
  one rule, and nothing that compared them.

  So this compares them the only way that cannot go stale: render the REAL control
  and put every option it renders through the REAL validator and the REAL
  formatter. A future edit to the hour window, the minute set, the pattern or the
  label rendering stays honest, and if any two are pulled apart again this fails on
  the actual values rather than on a copy of them.

  `arrival-time-editor.test.tsx` covers what the editor does with the control;
  this file is about the control's own contract with `@/lib/arrival-time`.
*/
describe("the arrival-time picker offers exactly what the API accepts (#2621)", () => {
  it("renders a real option list, so no assertion below can pass vacuously", () => {
    render(<TimePicker value={null} onChange={vi.fn()} />);
    // `every`/`filter` over an empty array would turn a picker that rendered
    // nothing into a passing contract test. 06:00-23:00 on the half hour is 35
    // options, so anything near zero is a broken control rather than a new
    // product decision.
    expect(renderedOptionValues()).toHaveLength(35);
  });

  it("offers no value the validator would refuse", () => {
    render(<TimePicker value={null} onChange={vi.fn()} />);
    const refused = renderedOptionValues().filter(
      (value) => !isValidArrivalTime(value),
    );
    expect(refused).toEqual([]);
  });

  it("offers EVERY canonical value inside its own hour window, and none outside it", () => {
    render(<TimePicker value={null} onChange={vi.fn()} />);

    // Built here from the shared minute set rather than typed out: the expected
    // list is `canonical ∩ 06:00-23:00`, which is the picker's documented
    // narrowing of the API's 00:00-23:30. Asserting the whole set both ways is
    // what catches a DROPPED option — "no invalid option" alone would pass a
    // picker that had quietly lost half its list.
    const expected: string[] = [];
    for (let hour = 6; hour <= 23; hour++) {
      for (const minutes of ARRIVAL_TIME_MINUTES) {
        if (hour === 23 && minutes === "30") continue;
        expected.push(`${String(hour).padStart(2, "0")}:${minutes}`);
      }
    }

    expect(renderedOptionValues()).toEqual(expected);
    // The narrowing is deliberate and documented in `@/lib/arrival-time`: the API
    // accepts the after-midnight arrival, the picker does not offer it. Pinned so
    // widening the picker is a decision somebody makes, not a side effect.
    expect(isValidArrivalTime("01:30")).toBe(true);
    expect(renderedOptionValues()).not.toContain("01:30");
  });

  it("labels every option through the shared formatter, not a private copy", () => {
    render(<TimePicker value={null} onChange={vi.fn()} />);
    // The picker held the fourth hand-rolled 12-hour renderer in the codebase, so
    // the option a member picked and the value their booking page, the kiosk and
    // the lobby wall read back could drift one edit at a time.
    for (const option of renderedOptions()) {
      expect(option.textContent).toBe(formatArrivalTime(option.value));
    }
    // Spot-check the two the hand-rolled copies always got wrong.
    expect(screen.getByRole("option", { name: "12:00 PM" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "6:00 AM" })).toBeInTheDocument();
  });

  it('keeps a "Not sure" choice whose value is empty, so nothing is forced', () => {
    render(<TimePicker value={null} onChange={vi.fn()} />);
    const notSure = screen.getByRole("option", { name: "Not sure" });
    expect(notSure).toHaveValue("");
  });

  it("names the control through the id its label points at", () => {
    // The accessibility half of the same defect: all three call sites already
    // wrote `htmlFor="arrival-time"`, and this rendered no id at all, so every one
    // of those labels pointed at nothing and announced a bare combo box.
    render(
      <>
        <label htmlFor="arrival-time">Expected Arrival Time</label>
        <TimePicker id="arrival-time" value={null} onChange={vi.fn()} />
      </>,
    );
    expect(
      screen.getByLabelText("Expected Arrival Time").tagName.toLowerCase(),
    ).toBe("select");
  });

  it("carries a description only when one is supplied", () => {
    const { rerender } = render(
      <TimePicker value={null} onChange={vi.fn()} id="t" />,
    );
    // An empty `aria-describedby` is not the same as none: it makes a screen
    // reader look for an element that is not there.
    expect(screen.getByRole("combobox")).not.toHaveAttribute("aria-describedby");

    rerender(
      <TimePicker value={null} onChange={vi.fn()} id="t" describedBy="hint-1" />,
    );
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "aria-describedby",
      "hint-1",
    );
  });
});

/** The rendered `<option>` elements except the "Not sure" empty choice. */
function renderedOptions(): HTMLOptionElement[] {
  return Array.from(
    document.querySelectorAll<HTMLOptionElement>("option"),
  ).filter((option) => option.value !== "");
}

/** Their values, in render order. */
function renderedOptionValues(): string[] {
  return renderedOptions().map((option) => option.value);
}
