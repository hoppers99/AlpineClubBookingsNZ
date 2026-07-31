// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
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
    storedCreditElectionCents: null,
    outstandingAdditionalCents: 0,
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

/** An unsettled booking with the mark-paid action offered. */
function payableState(
  overrides: Partial<BookingManualPaymentState> = {}
): BookingManualPaymentState {
  return {
    ...settledState(),
    amountOwingCents: 12000,
    canMarkPaid: true,
    manuallyMarkedPaidAt: null,
    manuallyMarkedPaidByName: null,
    canReverse: false,
    ...overrides,
  };
}

function openMarkPaidDialog(state: BookingManualPaymentState) {
  render(
    <BookingManualPaymentControls
      bookingId="bk_1"
      memberName="Ada Lovelace"
      state={state}
    />
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Record manual payment/i })
  );
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

/**
 * #2262 delta MED-3. Recording cash cannot honour a stored credit election — the
 * money changed hands outside the app — so the settle clears it. That is a
 * legitimate outcome and the settle must NOT be refused (refusing would strand
 * an admin holding the member's cash), but the click is the last preventable
 * moment, so the dialog has to say so BEFORE it, not only in the alert
 * afterwards.
 */
describe("BookingManualPaymentControls — stored credit election warning (#2262 / #2265)", () => {
  it("warns in the mark-paid dialog, naming the amount and saying the credit will go unused", () => {
    openMarkPaidDialog(payableState({ storedCreditElectionCents: 4500 }));

    const warning = screen.getByTestId("manual-payment-credit-election-warning");
    expect(warning.textContent).toContain("$45.00");
    expect(warning.textContent).toMatch(/cannot use it/i);
    expect(warning.textContent).toMatch(/remain available on their account/i);
    // Warned, never blocked: the admin can still record the cash they hold.
    expect(
      screen.getByRole("button", { name: "Record and email member" })
    ).toBeTruthy();
  });

  it("says nothing at all on the overwhelming majority of bookings, which carry no election", () => {
    openMarkPaidDialog(payableState());

    expect(
      screen.queryByTestId("manual-payment-credit-election-warning")
    ).toBeNull();
  });
});

/**
 * #2397. When a booking still carries an uncollected price increase, the person
 * holding the money has to be able to SEE what they are confirming — the extra,
 * and the total it is part of — and say whether the cash covers it. When there
 * is no such extra (nearly always) this common screen must be untouched.
 */
describe("BookingManualPaymentControls — the outstanding-extra question (#2397)", () => {
  function stubFetch() {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ message: "Payment recorded." }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  function requestBody(fetchMock: ReturnType<typeof stubFetch>) {
    const call = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    return JSON.parse(call[1].body) as Record<string, unknown>;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the extra, the amount before it, and the total being recorded", () => {
    openMarkPaidDialog(
      payableState({ amountOwingCents: 12100, outstandingAdditionalCents: 2100 })
    );

    const block = screen.getByTestId("manual-payment-additional-coverage");
    expect(block.textContent).toMatch(/part of the total shown above/i);
    // The split is spelled out rather than left to be inferred from one number.
    expect(
      screen.getByTestId("manual-payment-additional-base").textContent
    ).toBe("$100.00");
    expect(
      screen.getByTestId("manual-payment-additional-extra").textContent
    ).toBe("$21.00");
    expect(
      screen.getByTestId("manual-payment-additional-total").textContent
    ).toBe("$121.00");
  });

  it("blocks recording until the question is answered — neither answer is a default", () => {
    openMarkPaidDialog(
      payableState({ amountOwingCents: 12100, outstandingAdditionalCents: 2100 })
    );

    const record = screen.getByRole("button", {
      name: "Record and email member",
    }) as HTMLButtonElement;
    const recordSilently = screen.getByRole("button", {
      name: "Record without emailing",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(true);
    expect(recordSilently.disabled).toBe(true);

    fireEvent.click(screen.getByRole("radio", { name: /^No —/ }));
    expect(record.disabled).toBe(false);
  });

  it("sends the answer, with the figure the admin was shown, when the cash covers it", async () => {
    const fetchMock = stubFetch();
    openMarkPaidDialog(
      payableState({ amountOwingCents: 12100, outstandingAdditionalCents: 2100 })
    );

    fireEvent.click(screen.getByRole("radio", { name: /^Yes —/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record and email member" }));
    await Promise.resolve();

    expect(requestBody(fetchMock)).toMatchObject({
      direction: "paid",
      expectedAmountCents: 12100,
      additionalCoverage: {
        covered: true,
        expectedAdditionalAmountCents: 2100,
      },
    });
  });

  it("sends covered:false when the admin says the cash does not cover it", async () => {
    const fetchMock = stubFetch();
    openMarkPaidDialog(
      payableState({ amountOwingCents: 12100, outstandingAdditionalCents: 2100 })
    );

    fireEvent.click(screen.getByRole("radio", { name: /^No —/ }));
    fireEvent.click(screen.getByRole("button", { name: "Record and email member" }));
    await Promise.resolve();

    expect(requestBody(fetchMock)).toMatchObject({
      additionalCoverage: {
        covered: false,
        expectedAdditionalAmountCents: 2100,
      },
    });
  });

  it("is COMPLETELY unchanged when there is no extra — no question, no field, no block on recording", async () => {
    const fetchMock = stubFetch();
    openMarkPaidDialog(payableState());

    expect(
      screen.queryByTestId("manual-payment-additional-coverage")
    ).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    const record = screen.getByRole("button", {
      name: "Record and email member",
    }) as HTMLButtonElement;
    expect(record.disabled).toBe(false);

    fireEvent.click(record);
    await Promise.resolve();

    expect(requestBody(fetchMock)).not.toHaveProperty("additionalCoverage");
  });
});
