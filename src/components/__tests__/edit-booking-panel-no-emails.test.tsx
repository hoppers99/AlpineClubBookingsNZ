// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditBookingPanel } from "@/components/edit-booking-panel";

/*
  #2259 honesty rule on the admin edit path.

  An admin editing a booking is asked, per edit, whether the member is emailed
  (#1668/#1696). While the booking's "No emails" switch is on the mailer
  withholds the change notification whichever button is pressed, so the choice
  is not offered — the dialog states the position and saves down the
  send-nothing path.

  A MEMBER editing their own silenced booking must see none of this. The panel
  only reads the switch on the `viewerRole === "ADMIN"` path, and the booking
  page only serialises it there, so the member's dialog-free save is unchanged
  and nothing on the wire mentions the switch.
*/

const routerRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefresh, push: vi.fn() }),
}));

const BOOKING_ID = "bk-2259";

type FetchCall = { url: string; method: string; body: unknown };
let fetchCalls: FetchCall[];

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const OK_QUOTE = {
  newTotalPriceCents: 5000,
  newDiscountCents: 0,
  newPromoAdjustmentCents: 0,
  newFinalPriceCents: 5000,
  priceDiffCents: 0,
  changeFeeCents: 0,
  netChargeCents: 0,
  settlementOptions: null,
  capacityAvailable: true,
  promoStillValid: true,
  promoValidation: null,
  itemizedChanges: [],
};

function installFetch() {
  fetchCalls = [];
  global.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    let parsedBody: unknown;
    if (typeof init?.body === "string") {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    fetchCalls.push({ url, method: init?.method ?? "GET", body: parsedBody });

    if (url.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [], partnerSharingCandidates: [] });
    }
    if (url.includes("/api/age-tier-settings")) return jsonResponse({ settings: [] });
    if (url.includes("/modify-quote")) return jsonResponse(OK_QUOTE);
    return jsonResponse({ ok: true });
  }) as unknown as typeof fetch;
}

function makeBooking(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOKING_ID,
    checkIn: "2026-09-01",
    checkOut: "2026-09-03",
    guests: [
      {
        id: "g1",
        firstName: "Ada",
        lastName: "Adult",
        ageTier: "ADULT",
        isMember: true,
        memberId: null,
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 5000,
      },
      {
        id: "g2",
        firstName: "Bee",
        lastName: "Adult",
        ageTier: "ADULT",
        isMember: true,
        memberId: null,
        stayStart: null,
        stayEnd: null,
        nights: null,
        priceCents: 5000,
      },
    ],
    viewerRole: "ADMIN",
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
    ...overrides,
  };
}

/** Make a real change so Save Changes becomes enabled, then click it. */
async function openSaveDialog() {
  fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
  const save = screen.getByRole("button", { name: "Save Changes" });
  await waitFor(() => expect(save).not.toBeDisabled(), { timeout: 3000 });
  fireEvent.click(save);
}

function modifyCalls() {
  return fetchCalls.filter((c) =>
    c.url.endsWith(`/api/bookings/${BOOKING_ID}/modify`),
  );
}

beforeEach(() => {
  installFetch();
  routerRefresh.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("EditBookingPanel — No emails honesty rule (#2259)", () => {
  it("offers no email choice while the switch is on, and saves without a notify flag", async () => {
    render(
      <EditBookingPanel booking={makeBooking({ noEmails: true })} onDone={vi.fn()} />,
    );
    await openSaveDialog();

    const suppress = await screen.findByRole("button", {
      name: "Save changes",
    });
    expect(
      screen.queryByRole("button", { name: "Save and email member" }),
    ).toBeNull();
    expect(screen.getByText(/Emails are off for this booking/i)).toBeInTheDocument();

    fireEvent.click(suppress);
    await waitFor(() => expect(modifyCalls()).toHaveLength(1));
    /*
      #2259 H1: no notifyMember at all. `false` makes the route skip the send,
      so the mailer's gate never runs and the modification never reaches the
      booking's withheld list.
    */
    expect(modifyCalls()[0].body).not.toHaveProperty("notifyMember");
  });

  it("still offers the choice on an ordinary booking", async () => {
    render(
      <EditBookingPanel booking={makeBooking({ noEmails: false })} onDone={vi.fn()} />,
    );
    await openSaveDialog();

    expect(
      await screen.findByRole("button", { name: "Save and email member" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Emails are off for this booking/i)).toBeNull();
  });

  it("tells a member nothing, even if the flag reaches them", async () => {
    // Belt and braces: the booking page never serialises the flag to a member,
    // but if it ever did, the panel must still not render anything from it.
    render(
      <EditBookingPanel
        booking={makeBooking({ viewerRole: "MEMBER", noEmails: true })}
        onDone={vi.fn()}
      />,
    );
    await openSaveDialog();

    // A member self-edit has no notify dialog at all and saves immediately.
    await waitFor(() => expect(modifyCalls()).toHaveLength(1));
    expect(screen.queryByText(/Emails are off for this booking/i)).toBeNull();
    expect(modifyCalls()[0].body).not.toHaveProperty("notifyMember");
  });
});
