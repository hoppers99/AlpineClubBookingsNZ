import { describe, expect, it } from "vitest"
import {
  buildBookingRequestDatasetPath,
  getPaymentsDatasetDefaults,
  getReportsDatasetDefaults,
  resetPaymentsDatasetSearchParams,
  resetReportsDatasetState,
  resetSubscriptionsDatasetSearchParams,
  resetXeroInboundDatasetSearchParams,
  resetXeroOperationsDatasetSearchParams,
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

  it.each([
    {
      name: "booking approvals",
      defaultStatus: "PENDING",
      status: "ALL",
      recordKey: "bookingId" as const,
      recordId: "booking-1",
      fixedSearchParams: { tab: "approvals" },
    },
    {
      name: "booking changes",
      defaultStatus: "REQUESTED",
      status: "ALL",
      recordKey: "requestId" as const,
      recordId: "change-1",
      fixedSearchParams: { tab: "changes" },
    },
    {
      name: "public booking requests",
      defaultStatus: "QUEUE",
      status: "QUEUE",
      recordKey: "requestId" as const,
      recordId: "public-1",
      fixedSearchParams: { tab: "public" },
    },
  ])(
    "preserves record, tab, and unknown context when resetting $name",
    ({
      defaultStatus,
      status,
      recordKey,
      recordId,
      fixedSearchParams,
    }) => {
      const path = buildBookingRequestDatasetPath({
        basePath: "/admin/booking-requests",
        currentSearch: `status=APPROVED&${recordKey}=${recordId}&futureContext=keep`,
        fixedSearchParams,
        status,
        defaultStatus,
        recordKey,
        recordId,
      })
      const params = new URL(path, "https://example.test").searchParams

      expect(params.get(recordKey)).toBe(recordId)
      expect(params.get("tab")).toBe(Object.values(fixedSearchParams)[0])
      expect(params.get("futureContext")).toBe("keep")
      expect(params.get("status")).toBe(
        status === defaultStatus ? null : status,
      )
    },
  )

  it("resets only the Xero Operations dataset and preserves its section, sibling, and unknown state", () => {
    const params = resetXeroOperationsDatasetSearchParams(
      "section=inbound&opStatus=FAILED&opPage=4&inStatus=RECEIVED&inPage=2&futureContext=keep",
    )

    expect(params.get("section")).toBe("operations")
    expect(params.get("inStatus")).toBe("RECEIVED")
    expect(params.get("inPage")).toBe("2")
    expect(params.get("futureContext")).toBe("keep")
    expect(params.has("opStatus")).toBe(false)
    expect(params.has("opPage")).toBe(false)
  })

  it("resets only the Xero Inbound dataset and preserves its section, sibling, and unknown state", () => {
    const params = resetXeroInboundDatasetSearchParams(
      "section=operations&inStatus=FAILED&inPage=3&opStatus=PARTIAL&opPage=2&futureContext=keep",
    )

    expect(params.get("section")).toBe("inbound")
    expect(params.get("opStatus")).toBe("PARTIAL")
    expect(params.get("opPage")).toBe("2")
    expect(params.get("futureContext")).toBe("keep")
    expect(params.has("inStatus")).toBe(false)
    expect(params.has("inPage")).toBe(false)
  })

  it("restores Reports defaults while preserving lodge context", () => {
    expect(getReportsDatasetDefaults("2026-08-01")).toEqual({
      from: "2026-05-01",
      to: "2026-08-31",
      deleted: "hide",
    })
    expect(
      resetReportsDatasetState({ lodgeId: "lodge-2" }, "2026-08-01"),
    ).toEqual({
      from: "2026-05-01",
      to: "2026-08-31",
      deleted: "hide",
      lodgeId: "lodge-2",
    })
  })
})
