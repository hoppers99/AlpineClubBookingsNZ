// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DatasetResetButton } from "@/components/admin/dataset-reset-button"

describe("DatasetResetButton", () => {
  it("remains visible and exposes why it is disabled at the dataset default", () => {
    render(<DatasetResetButton disabled onReset={() => undefined} />)

    const reset = screen.getByRole("button", {
      name: /Reset\. Search, filters, sort, and page are already at their defaults\./,
    })
    expect((reset as HTMLButtonElement).disabled).toBe(true)
    expect(reset.textContent).toContain("Reset")
  })

  it("runs the reset transaction when dataset state is dirty", () => {
    const onReset = vi.fn()
    render(<DatasetResetButton disabled={false} onReset={onReset} />)

    fireEvent.click(screen.getByRole("button", { name: "Reset" }))

    expect(onReset).toHaveBeenCalledTimes(1)
  })
})
