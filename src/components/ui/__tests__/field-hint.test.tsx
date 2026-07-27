// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  FieldHint,
  describedByFieldHint,
  useFieldHint,
} from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// #2257 — the point of this primitive is the ASSISTIVE-TECH association, not
// the grey text. A hint that merely sits below an input is invisible to a
// screen reader focusing that input, which is the defect these tests pin.

function HintedField({ errorId }: { errorId?: string }) {
  const hint = useFieldHint(errorId);
  return (
    <div>
      <Label htmlFor="season-name">Season Name</Label>
      {errorId ? <p id={errorId}>Enter a season name.</p> : null}
      <Input id="season-name" {...hint.fieldProps} />
      <FieldHint {...hint.hintProps}>Example: Winter 2026</FieldHint>
    </div>
  );
}

describe("FieldHint / useFieldHint", () => {
  it("points the described control at the hint it renders", () => {
    render(<HintedField />);

    const field = screen.getByLabelText("Season Name");
    const describedBy = field.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    // The id must resolve to the hint element actually in the document — the
    // wiring, not just the presence of an attribute.
    const hint = document.getElementById(describedBy ?? "");
    expect(hint).not.toBeNull();
    expect(hint).toHaveTextContent("Example: Winter 2026");
    expect(hint?.tagName).toBe("P");
  });

  it("announces an error before the hint when both describe the field", () => {
    render(<HintedField errorId="season-name-error" />);

    const field = screen.getByLabelText("Season Name");
    const ids = (field.getAttribute("aria-describedby") ?? "").split(" ");

    // Both descriptions survive — a hint must never displace an error.
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe("season-name-error");
    expect(document.getElementById(ids[1] ?? "")).toHaveTextContent(
      "Example: Winter 2026",
    );
  });

  it("drops falsy preceding ids so a conditional id can be passed straight through", () => {
    function Conditional() {
      const hint = useFieldHint(false, null, undefined, "");
      return (
        <>
          <Input aria-label="Code" {...hint.fieldProps} />
          <FieldHint {...hint.hintProps}>Example: WINTER20</FieldHint>
        </>
      );
    }
    render(<Conditional />);

    const ids = (
      screen.getByLabelText("Code").getAttribute("aria-describedby") ?? ""
    ).split(" ");
    expect(ids).toHaveLength(1);
    expect(document.getElementById(ids[0] ?? "")).toHaveTextContent(
      "Example: WINTER20",
    );
  });

  it("gives every field its own hint id when the same component renders twice", () => {
    render(
      <>
        <HintedField />
        <HintedField />
      </>,
    );

    const [first, second] = screen.getAllByLabelText("Season Name");
    expect(first?.getAttribute("aria-describedby")).toBeTruthy();
    expect(first?.getAttribute("aria-describedby")).not.toBe(
      second?.getAttribute("aria-describedby"),
    );
  });

  it("orders caller-supplied ids the same way for the .map() helper", () => {
    // Rows rendered inside a `.map()` cannot call a hook per row, so they pass a
    // deterministic id. The ordering contract must not differ between the two.
    expect(describedByFieldHint("hint-1", "view-only-reason")).toBe(
      "view-only-reason hint-1",
    );
    expect(describedByFieldHint("hint-1", false, undefined, null, "")).toBe(
      "hint-1",
    );
  });

  it("renders as muted helper text below the control", () => {
    render(<FieldHint id="h">Example: Winter 2026</FieldHint>);
    expect(screen.getByText("Example: Winter 2026").className).toContain(
      "text-muted-foreground",
    );
  });
});
