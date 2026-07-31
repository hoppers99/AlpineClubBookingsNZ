// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

// #2390 — a promotion that no longer reaches everybody must be explained AT the
// edit, not discovered on an invoice.
//
// The preview reads the promotion's counters unlocked; the save re-reads them
// under the promo row lock. Another booking can take the last slot in between,
// and then the price the member is charged is not the price the panel explained.
// The save response carries the server's own coverage sentence for exactly that
// case — reading only the error codes out of it and closing the panel is what
// left the member to find out from the email afterwards.

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2390";

const PREVIEW_MESSAGE =
  "Promo code SUMMER25 has reached its limit, so it stays with Ann Hughes, " +
  "who already had it, and does not extend to Cal Hughes — Cal Hughes is " +
  "priced at the normal rate. The total shown already includes this.";
const SAVE_MESSAGE =
  "Promo code SUMMER25 has reached its limit, so it stays with Ann Hughes, " +
  "who already had it, and does not extend to Bob Hughes and Cal Hughes — " +
  "Bob Hughes and Cal Hughes are priced at the normal rate. The total shown " +
  "already includes this.";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function quotePayload(coverageMessage: string | null) {
  return {
    newTotalPriceCents: 15000,
    newDiscountCents: 2000,
    newPromoAdjustmentCents: -2000,
    newFinalPriceCents: 13000,
    priceDiffCents: 3000,
    changeFeeCents: 0,
    netChargeCents: 3000,
    settlementOptions: null,
    capacityAvailable: true,
    promoStillValid: true,
    promoCoverage: coverageMessage
      ? {
          promoCode: "SUMMER25",
          coveredNames: ["Ann Hughes"],
          retainedNames: ["Ann Hughes"],
          excludedNames: ["Cal Hughes"],
          message: coverageMessage,
        }
      : null,
    promoValidation: null,
    itemizedChanges: [],
  };
}

let quoteCoverageMessage: string | null;
let modifyResponse: () => Response;

function installFetch() {
  quoteCoverageMessage = PREVIEW_MESSAGE;
  modifyResponse = () => jsonResponse({ ok: true });
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) {
      return jsonResponse({ settings: [] });
    }
    if (url.includes("/modify-quote")) {
      return jsonResponse(quotePayload(quoteCoverageMessage));
    }
    if (url.endsWith(`/api/bookings/${BOOKING_ID}/modify`)) {
      return modifyResponse();
    }
    void init;
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function makeBooking() {
  return {
    id: BOOKING_ID,
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    guests: [
      {
        id: "g1",
        firstName: "Ann",
        lastName: "Hughes",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-ann",
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 5000,
      },
      {
        id: "g2",
        firstName: "Cal",
        lastName: "Hughes",
        ageTier: "ADULT",
        isMember: true,
        memberId: "member-cal",
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 5000,
      },
    ],
    viewerRole: "MEMBER",
    finalPriceCents: 10000,
    totalPriceCents: 12000,
    discountCents: 2000,
    promoAdjustmentCents: -2000,
    promo: {
      code: "SUMMER25",
      type: "PERCENTAGE",
      description: "Summer 25% off",
    },
    canEditNonMemberGuestNames: true,
    canFixNonMemberGuestNameTypos: true,
    editPolicy: {
      mode: "future" as const,
      today: "2026-08-01",
      editableFrom: null,
      checkInEditable: true,
      adminOverrideAvailable: false,
    },
    requiresAdminReview: false,
    adminReviewStatus: null,
  };
}

async function makeAChangeAndWaitForSave() {
  // A date change is the simplest edit that produces a quote.
  fireEvent.change(screen.getByLabelText(/Check-out/i), {
    target: { value: "2026-09-04" },
  });
  const saveButton = screen.getByRole("button", { name: "Save Changes" });
  await waitFor(() => expect(saveButton).not.toBeDisabled(), { timeout: 2500 });
  return saveButton;
}

beforeEach(() => {
  installFetch();
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — partial promo coverage (#2390)", () => {
  it("shows the preview's coverage sentence, announced to a screen reader", async () => {
    render(<EditBookingPanel booking={makeBooking()} onDone={vi.fn()} />);

    await makeAChangeAndWaitForSave();

    const notice = await screen.findByTestId("promo-coverage-notice");
    expect(notice).toHaveTextContent("does not extend to Cal Hughes");
    // Appears on its own when the quote comes back, so it must announce itself.
    expect(notice).toHaveAttribute("role", "status");
  });

  it("holds the panel open when the SAVE covers fewer people than the preview did", async () => {
    const onDone = vi.fn();
    modifyResponse = () =>
      jsonResponse({
        promoCoverage: {
          promoCode: "SUMMER25",
          coveredNames: ["Ann Hughes"],
          retainedNames: ["Ann Hughes"],
          excludedNames: ["Bob Hughes", "Cal Hughes"],
          message: SAVE_MESSAGE,
        },
      });

    render(<EditBookingPanel booking={makeBooking()} onDone={onDone} />);
    const saveButton = await makeAChangeAndWaitForSave();
    fireEvent.click(saveButton);

    const notice = await screen.findByTestId("saved-promo-coverage-notice");
    expect(notice).toHaveTextContent("Your change is saved");
    expect(notice).toHaveTextContent(SAVE_MESSAGE);
    expect(notice).toHaveAttribute("role", "status");
    // The edit HAS been saved, so Save must not be offered a second time.
    expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull();
    expect(routerRefresh).toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("closes as usual when the save says exactly what the preview already said", async () => {
    const onDone = vi.fn();
    modifyResponse = () =>
      jsonResponse({
        promoCoverage: {
          promoCode: "SUMMER25",
          coveredNames: ["Ann Hughes"],
          retainedNames: ["Ann Hughes"],
          excludedNames: ["Cal Hughes"],
          message: PREVIEW_MESSAGE,
        },
      });

    render(<EditBookingPanel booking={makeBooking()} onDone={onDone} />);
    const saveButton = await makeAChangeAndWaitForSave();
    fireEvent.click(saveButton);

    // Re-showing a sentence the member already read and accepted is not news.
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("saved-promo-coverage-notice")).toBeNull();
  });

  it("closes as usual when the save left nobody out", async () => {
    const onDone = vi.fn();
    quoteCoverageMessage = null;
    modifyResponse = () => jsonResponse({ promoCoverage: null });

    render(<EditBookingPanel booking={makeBooking()} onDone={onDone} />);
    const saveButton = await makeAChangeAndWaitForSave();
    fireEvent.click(saveButton);

    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("saved-promo-coverage-notice")).toBeNull();
  });
});
