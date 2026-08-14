// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

/*
  #2690 — the debounced modify-quote arm, pinned by COUNTING REQUESTS rather than
  by reading the screen.

  WHY THIS SUITE EXISTS. The panel's other twelve suites assert rendered output,
  and rendered output is nearly blind to the failure this one is about: a
  dependency array that gains or loses an entry. `fetchQuote` is memoised on
  `[bookingId, …stable setters]` and the debounce effect is keyed on
  `[fetchQuote, modificationPayloadJson, …stable setters]`. Put a value in either
  array that is rebuilt on every render — a payload object instead of its
  serialised form, an inline callback, a `useMemo` with the wrong inputs — and the
  effect re-arms its own timer on the render its own response causes. The panel
  then refetches every 500ms, for ever, and every screen assertion in the repo
  still passes, because the numbers on screen are correct. That regression is
  recorded in the effect's own comment; this is the guard for it.

  The other two arms of the same effect are pinned here for the same reason: the
  debounce must COALESCE a burst into one request carrying the LAST payload (a
  broken key would send one per keystroke, each priced on a party the member has
  already moved on from), and an edit reverted to nothing must clear the quote
  WITHOUT asking the server to price "no change".
*/

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2690";

/** Every modify-quote request body this render has sent, oldest first. */
let quoteRequestBodies: string[] = [];

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function quotePayload() {
  return {
    newTotalPriceCents: 12000,
    newDiscountCents: 0,
    newPromoAdjustmentCents: 0,
    newFinalPriceCents: 12000,
    priceDiffCents: 2000,
    changeFeeCents: 0,
    netChargeCents: 2000,
    settlementOptions: null,
    capacityAvailable: true,
    promoStillValid: true,
    promoCoverage: null,
    promoValidation: null,
    itemizedChanges: [],
  };
}

function installFetch() {
  quoteRequestBodies = [];
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/promo-codes/available")) {
      return jsonResponse([]);
    }
    if (url.includes("/api/age-tier-settings")) {
      return jsonResponse({ settings: [] });
    }
    if (url.includes("/modify-quote")) {
      quoteRequestBodies.push(String(init?.body ?? ""));
      return jsonResponse(quotePayload());
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;
}

function makeBooking() {
  return {
    id: BOOKING_ID,
    // Fixed against the frozen clock (2026-07-01): permanently a future stay, so
    // the panel is always in "future" edit mode.
    checkIn: "2026-09-04",
    checkOut: "2026-09-06",
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
    ],
    viewerRole: "MEMBER",
    finalPriceCents: 10000,
    totalPriceCents: 10000,
    discountCents: 0,
    promoAdjustmentCents: 0,
    promo: null,
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

function setCheckOut(value: string) {
  fireEvent.change(screen.getByLabelText(/Check-out/i), { target: { value } });
}

/**
 * The debounce window is a real 500ms timer: the frozen test clock fakes `Date`
 * only (`toFake: ["Date"]`), so `setTimeout` is genuinely asynchronous here.
 * Waiting longer than several windows is what makes "it did not loop" a real
 * observation rather than a race the test happened to win.
 */
const THREE_DEBOUNCE_WINDOWS_MS = 1_700;

function settle(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  installFetch();
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — the debounced modify-quote arm (#2690)", () => {
  it("prices a settled edit exactly once and does not re-arm on its own response", async () => {
    render(
      <EditBookingPanel booking={makeBooking()} onDone={() => {}} />,
    );

    setCheckOut("2026-09-08");
    await waitFor(
      () => expect(screen.getByRole("button", { name: "Save Changes" })).not.toBeDisabled(),
      { timeout: 2500 },
    );
    expect(quoteRequestBodies).toHaveLength(1);

    // The whole point. A dependency that is rebuilt every render makes the
    // effect re-arm on the render its own response causes, so the count climbs
    // by roughly one per 500ms while the screen stays perfectly correct.
    await settle(THREE_DEBOUNCE_WINDOWS_MS);
    expect(
      quoteRequestBodies,
      "the quote effect re-armed itself: it is keyed on something rebuilt every " +
        "render, which refetches every 500ms for as long as the panel is open",
    ).toHaveLength(1);
  });

  it("coalesces a burst of edits into one request carrying the last payload", async () => {
    render(
      <EditBookingPanel booking={makeBooking()} onDone={() => {}} />,
    );

    setCheckOut("2026-09-07");
    setCheckOut("2026-09-08");
    setCheckOut("2026-09-09");

    await waitFor(
      () => expect(screen.getByRole("button", { name: "Save Changes" })).not.toBeDisabled(),
      { timeout: 2500 },
    );
    await settle(THREE_DEBOUNCE_WINDOWS_MS);

    expect(quoteRequestBodies).toHaveLength(1);
    expect(JSON.parse(quoteRequestBodies[0])).toMatchObject({
      checkOut: "2026-09-09",
    });
  });

  it("clears the quote without asking the server to price an edit that no longer exists", async () => {
    render(
      <EditBookingPanel booking={makeBooking()} onDone={() => {}} />,
    );

    setCheckOut("2026-09-08");
    await waitFor(
      () => expect(screen.getByRole("button", { name: "Save Changes" })).not.toBeDisabled(),
      { timeout: 2500 },
    );
    expect(quoteRequestBodies).toHaveLength(1);

    // Back to the stored dates: `hasChanges` goes false, the payload goes null,
    // and that arm of the effect returns WITHOUT arming a timer.
    setCheckOut("2026-09-06");
    await waitFor(
      () => expect(screen.getByRole("button", { name: "Save Changes" })).toBeDisabled(),
      { timeout: 2500 },
    );
    await settle(THREE_DEBOUNCE_WINDOWS_MS);

    expect(quoteRequestBodies).toHaveLength(1);
    // The Price Summary is gated on `hasChanges`, so a cleared edit takes the
    // whole card away rather than leaving last quote's figures on screen.
    expect(screen.queryByText("Price Summary")).not.toBeInTheDocument();
  });

  it("asks the family route once per mount, not once per edit", async () => {
    render(
      <EditBookingPanel booking={makeBooking()} onDone={() => {}} />,
    );

    setCheckOut("2026-09-08");
    await waitFor(
      () => expect(screen.getByRole("button", { name: "Save Changes" })).not.toBeDisabled(),
      { timeout: 2500 },
    );
    await settle(THREE_DEBOUNCE_WINDOWS_MS);

    // The loader is keyed on [bookingId, viewerRole]. Widening that array to
    // anything the panel recomputes turns a one-shot mount fetch into a fetch
    // per edit — the same class of defect as the quote loop above, on the arm
    // whose answer decides whether the consent prediction is shown at all.
    const familyCalls = (global.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((call) => String(call[0]).includes("/api/members/family"));
    expect(familyCalls).toHaveLength(1);
  });
});
