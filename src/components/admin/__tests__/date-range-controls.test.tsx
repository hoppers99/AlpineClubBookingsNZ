// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DateRangeControls } from "@/components/admin/date-range-controls";
import { reportsDateRangePresets } from "@/lib/date-range-presets";

describe("DateRangeControls", () => {
  it("associates the shared Quick Range label with its select", () => {
    render(
      <DateRangeControls
        presets={reportsDateRangePresets}
        from="2026-04-01"
        to="2026-04-30"
        onFromChange={vi.fn()}
        onToChange={vi.fn()}
        idPrefix="reports-range"
      />,
    );

    expect(screen.getByLabelText("Quick Range")).toBe(
      screen.getByRole("combobox", { name: "Quick Range" }),
    );
    expect(screen.getByLabelText("Quick Range")).toHaveAttribute(
      "id",
      "reports-range-preset",
    );
  });

  it("applies Next Month through the shared select", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:00Z"));
    const onFromChange = vi.fn();
    const onToChange = vi.fn();

    render(
      <DateRangeControls
        presets={reportsDateRangePresets}
        from="2026-04-01"
        to="2026-04-30"
        onFromChange={onFromChange}
        onToChange={onToChange}
      />,
    );

    fireEvent.change(screen.getByRole("combobox", { name: "Quick Range" }), {
      target: { value: "next_month" },
    });

    expect(onFromChange).toHaveBeenCalledWith("2026-05-01");
    expect(onToChange).toHaveBeenCalledWith("2026-05-31");
    vi.useRealTimers();
  });
});
