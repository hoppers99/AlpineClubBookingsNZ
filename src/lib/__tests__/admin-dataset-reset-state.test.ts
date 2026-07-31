import { describe, expect, it } from "vitest"
import {
  getPaymentsDatasetDefaults,
  resetPaymentsDatasetSearchParams,
  resetSubscriptionsDatasetSearchParams,
} from "@/lib/admin-dataset-reset-state"

describe("admin dataset reset state", () => {
  it("restores Payments to the rolling NZ three-month range and preserves unknown keys", () => {
    expect(getPaymentsDatasetDefaults("2026-08-01")).toEqual({
      lastUpdatedFrom: "2026-05-01",
      lastUpdatedTo: "2026-08-01",
    })

    const params = resetPaymentsDatasetSearchParams(
      "futureContext=keep&status=FAILED&lastUpdatedFrom=2020-01-01&lastUpdatedTo=2020-01-02&sortBy=amount&sortDir=asc&page=4",
      "2026-08-01",
    )

    expect(params.get("futureContext")).toBe("keep")
    expect(params.get("lastUpdatedFrom")).toBe("2026-05-01")
    expect(params.get("lastUpdatedTo")).toBe("2026-08-01")
    for (const key of ["status", "sortBy", "sortDir", "page"]) {
      expect(params.has(key)).toBe(false)
    }
  })

  it("resets Subscriptions filters, sort, and page while preserving season and unknown context", () => {
    const params = resetSubscriptionsDatasetSearchParams(
      "seasonYear=2025&futureContext=keep&status=PAID&ageTier=ADULT&sortBy=paidAt&sortDir=desc&page=3",
    )

    expect(params.get("seasonYear")).toBe("2025")
    expect(params.get("futureContext")).toBe("keep")
    for (const key of ["status", "ageTier", "sortBy", "sortDir", "page"]) {
      expect(params.has(key)).toBe(false)
    }
  })
})
