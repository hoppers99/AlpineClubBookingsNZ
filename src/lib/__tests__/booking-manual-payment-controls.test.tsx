// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/use-admin-area-edit-access")
  >()),
  useAdminAreaEditAccess: () => true,
}));

import {
  BookingManualPaymentControls,
  type BookingManualPaymentState,
} from "@/components/admin/booking-manual-payment-controls";

function settledState(
  overrides: Partial<BookingManualPaymentState> = {}
): BookingManualPaymentState {
  return {
    amountOwingCents: 0,
    canMarkPaid: false,
    markPaidBlockedReason: null,
    manuallyMarkedPaidAt: "2026-07-20T00:00:00Z",
    manuallyMarkedPaidByName: "Ada Lovelace",
    manualPaymentNote: null,
    canReverse: true,
    reverseBlockedReason: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BookingManualPaymentControls — reversal dialog copy (#2262 M5)", () => {
  it("spells out the capacity consequence: restored awaiting-payment stops holding beds, and a later re-record can be refused", () => {
    render(
      <BookingManualPaymentControls
        bookingId="bk_1"
        memberName="Ada Lovelace"
        state={settledState()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Reverse manual payment" })
    );

    // The reversal's own effect…
    expect(
      screen.getByText(/goes back to being unpaid/i)
    ).toBeTruthy();
    // …AND its converse capacity consequence, so the admin is not surprised
    // when the beds are gone by the time the payment is re-recorded.
    expect(
      screen.getByText(/stops holding its beds/i)
    ).toBeTruthy();
    expect(
      screen.getByText(/can be refused if the lodge has filled/i)
    ).toBeTruthy();
  });
});
