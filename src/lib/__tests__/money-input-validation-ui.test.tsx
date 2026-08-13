// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CancellationRulesEditor } from "@/components/admin/booking-policies/cancellation-rules-editor";
import type { PolicyRule } from "@/components/admin/booking-policies/types";

/**
 * #2685, owner decision 3 (9 Aug 2026): "Invalid money input is rejected with a
 * visible validation error. Do not coerce malformed/unparseable input to zero…
 * the error state has to be genuinely wired into the UI, not left as a `null`
 * that renders nothing."
 *
 * This proves the wiring end to end on the cancellation fixed-fee box, which was
 * the most explicit offender: it read `Math.round((parseFloat(v) || 0) * 100)`,
 * so anything the parser could not read became a cancellation fee of $0.00 with
 * nothing on screen. The message must be VISIBLE, the stored cents must not
 * move, and the surrounding section must learn that it may not save.
 */

const BASE_RULE: PolicyRule = {
  daysBeforeStay: 7,
  refundPercentage: 50,
  creditRefundPercentage: 50,
  fixedFeeCents: 2500,
  creditFixedFeeCents: 1000,
};

function Harness({
  onInvalidAmountsChange,
  onRulesChange,
}: {
  onInvalidAmountsChange?: (invalid: boolean) => void;
  onRulesChange?: (rules: PolicyRule[]) => void;
}) {
  const [rules, setRules] = useState<PolicyRule[]>([BASE_RULE]);
  return (
    <CancellationRulesEditor
      rules={rules}
      onChange={(next) => {
        setRules(next);
        onRulesChange?.(next);
      }}
      onInvalidAmountsChange={onInvalidAmountsChange}
    />
  );
}

/** The card fixed-fee box is the fourth number input in the row. */
function feeBox(): HTMLInputElement {
  return screen.getAllByRole("spinbutton")[3] as HTMLInputElement;
}

function typeInto(value: string) {
  fireEvent.change(feeBox(), { target: { value } });
}

describe("a refused money amount is visible in the UI", () => {
  it("shows an error, keeps the stored cents, and blocks the section's save", () => {
    const onInvalidAmountsChange = vi.fn();
    const onRulesChange = vi.fn();

    render(
      <Harness
        onInvalidAmountsChange={onInvalidAmountsChange}
        onRulesChange={onRulesChange}
      />,
    );

    expect(feeBox().value).toBe("25.00");
    expect(onInvalidAmountsChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("alert")).toBeNull();

    // Three decimal places: unsupported precision on a typed amount.
    typeInto("25.005");

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Enter a fee in dollars and cents");

    // The box still shows exactly what was typed — it does not snap back and
    // pretend the entry never happened.
    expect(feeBox().value).toBe("25.005");

    // The fee never became 2500.5, 2501, or 0: no rule update was emitted at
    // all, so the last accepted value stands and the section is told to refuse.
    expect(onRulesChange).not.toHaveBeenCalled();
    expect(onInvalidAmountsChange).toHaveBeenLastCalledWith(true);
  });

  it("clears the error and resumes saving once a valid amount is typed", () => {
    const onInvalidAmountsChange = vi.fn();
    const onRulesChange = vi.fn();

    render(
      <Harness
        onInvalidAmountsChange={onInvalidAmountsChange}
        onRulesChange={onRulesChange}
      />,
    );

    typeInto("12.345");
    expect(screen.getByRole("alert")).toBeTruthy();

    typeInto("12.34");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(onInvalidAmountsChange).toHaveBeenLastCalledWith(false);
    const lastRules = onRulesChange.mock.calls.at(-1)?.[0] as PolicyRule[];
    expect(lastRules[0].fixedFeeCents).toBe(1234);
  });

  it("treats an emptied box as a deliberate zero fee, not an error", () => {
    const onInvalidAmountsChange = vi.fn();
    const onRulesChange = vi.fn();

    render(
      <Harness
        onInvalidAmountsChange={onInvalidAmountsChange}
        onRulesChange={onRulesChange}
      />,
    );

    typeInto("");

    expect(screen.queryByRole("alert")).toBeNull();
    expect(onInvalidAmountsChange).toHaveBeenLastCalledWith(false);
    const lastRules = onRulesChange.mock.calls.at(-1)?.[0] as PolicyRule[];
    expect(lastRules[0].fixedFeeCents).toBe(0);
  });

  it("refuses a negative fee, which the old parser accepted", () => {
    const onRulesChange = vi.fn();
    render(<Harness onRulesChange={onRulesChange} />);

    // `min="0"` is advisory: the browser does not stop a typed minus sign, and
    // `parseFloat("-5")` used to store a fixed fee of MINUS $5.
    typeInto("-5.00");

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(onRulesChange).not.toHaveBeenCalled();
  });

  it("names the error element from the input it belongs to", () => {
    render(<Harness />);

    typeInto("1.005");

    const alert = screen.getByRole("alert");
    expect(alert.id).toBeTruthy();
    expect(feeBox().getAttribute("aria-describedby")).toBe(alert.id);
    expect(feeBox().getAttribute("aria-invalid")).toBe("true");
  });
});
