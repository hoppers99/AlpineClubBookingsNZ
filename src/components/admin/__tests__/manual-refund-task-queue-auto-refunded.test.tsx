// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>()),
  useAdminAreaEditAccess: () => true,
}));

import { ManualRefundTaskQueue } from "@/components/admin/manual-refund-task-queue";

/**
 * #2750 — the operator surface for a refund nobody decided.
 *
 * A modification payment captured against a booking the club has already deleted
 * is refunded in full by the #1350 Stripe webhook, and #2700 made that leave a
 * `ManualRefundTask` behind, which the webhook then closes itself as DISMISSED
 * because there is genuinely nothing left to hand back. #2750 kept the automatic
 * refund — the member's money going back is the safe direction when nobody is
 * watching — and fixed the half that was missing: a closed row appeared on no
 * screen at all, because this queue lists OPEN rows.
 *
 * The card is named here, which is the issue's acceptance criterion: the finance
 * queue on `/admin/payments`, `data-testid="automatic-refund-notices"`.
 *
 * MUTATION PROOF. Return the automatic refunds as part of `tasks` instead of
 * their own list and "never renders an automatic refund with a button" fails.
 * Keep the component's original `tasks.length === 0` early return and "shows the
 * record even when nothing is waiting to be paid back by hand" fails. Drop the
 * note or the reason from the row and "says both what happened and that the money
 * has already gone" fails. Render the card on an empty list and "renders nothing
 * at all when there is neither work nor a record" fails.
 */

const OPEN_TASK = {
  id: "task-open",
  bookingId: "booking-cash",
  amountCents: 8000,
  reason: "Cancelled after a cash payment",
  createdAt: "2026-06-20T00:00:00Z",
  memberName: "Ada Lovelace",
  checkIn: "2026-08-10T00:00:00Z",
  checkOut: "2026-08-12T00:00:00Z",
};

const AUTO_REFUND = {
  id: "task-auto",
  bookingId: "booking-deleted",
  amountCents: 2500,
  reason:
    "Booking modification payment pi_modification was captured against a booking the club had already deleted (#2700). Decide by hand whether to refund it.",
  note: "Closed automatically: Stripe refunded this capture under the cancelled-booking late-capture path, so there is nothing left to pay back by hand (payment intent pi_modification).",
  refundedAt: "2026-06-28T09:00:00Z",
  memberName: "Grace Hopper",
  checkIn: "2026-08-10T00:00:00Z",
  checkOut: "2026-08-12T00:00:00Z",
};

/** Serves one load of the queue endpoint and nothing else. */
function stubLoad(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ManualRefundTaskQueue — automatically refunded late captures (#2750)", () => {
  it("shows the record even when nothing is waiting to be paid back by hand", async () => {
    // This is the case that matters, and the one the pre-#2750 component could
    // not render: the webhook is healthy, so there is no OPEN work, and the only
    // trace of the refund is a closed row.
    stubLoad({ tasks: [], autoRefunded: [AUTO_REFUND] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("manual-refund-task-queue"),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Grace Hopper/)).toBeInTheDocument();
  });

  it("names the member, the amount and the day the money went back", async () => {
    stubLoad({ tasks: [], autoRefunded: [AUTO_REFUND] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument(),
    );
    const card = screen.getByTestId("automatic-refund-notices");
    expect(card).toHaveTextContent("Grace Hopper");
    expect(card).toHaveTextContent("$25.00");
    expect(card).toHaveTextContent(/refunded on/i);
  });

  it("says both what happened and that the money has already gone", async () => {
    // The reason ends with "Decide by hand whether to refund it" — read on its
    // own it asks for a decision that is no longer anybody's to make. The note is
    // what closes that off, so both have to be on screen.
    stubLoad({ tasks: [], autoRefunded: [AUTO_REFUND] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument(),
    );
    const card = screen.getByTestId("automatic-refund-notices");
    expect(card).toHaveTextContent(/already deleted/);
    expect(card).toHaveTextContent(/Closed automatically/);
    expect(card).toHaveTextContent(/nothing to pay back/i);
  });

  it("tells the operator the one thing they may still have to do", async () => {
    // If the DELETION was the mistake rather than the payment, the refund has
    // already gone out and the member has to be charged again. That is the whole
    // reason the record has to be seen at all.
    stubLoad({ tasks: [], autoRefunded: [AUTO_REFUND] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("automatic-refund-notices")).toHaveTextContent(
      /charged again/i,
    );
  });

  it("never renders an automatic refund with a button", async () => {
    // There is no decision left. A control here would say there is, and "Mark
    // paid back" on this row would write a second refund allocation.
    stubLoad({ tasks: [], autoRefunded: [AUTO_REFUND] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("automatic-refund-notices")).toBeInTheDocument(),
    );
    const card = screen.getByTestId("automatic-refund-notices");
    expect(card.querySelectorAll("button")).toHaveLength(0);
    expect(screen.queryByText("Mark paid back")).not.toBeInTheDocument();
    expect(screen.queryByText("Dismiss")).not.toBeInTheDocument();
  });

  it("shows both cards, separately, when there is work AND a record", async () => {
    stubLoad({ tasks: [OPEN_TASK], autoRefunded: [AUTO_REFUND] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("manual-refund-task-queue")).toBeInTheDocument(),
    );
    const queue = screen.getByTestId("manual-refund-task-queue");
    const notices = screen.getByTestId("automatic-refund-notices");
    // The hand-back row keeps its controls; the record has none, and neither
    // list contains the other's row.
    expect(queue).toHaveTextContent("Ada Lovelace");
    expect(queue).not.toHaveTextContent("Grace Hopper");
    expect(notices).toHaveTextContent("Grace Hopper");
    expect(notices).not.toHaveTextContent("Ada Lovelace");
    expect(queue.querySelectorAll("button").length).toBeGreaterThan(0);
  });

  it("renders nothing at all when there is neither work nor a record", async () => {
    stubLoad({ tasks: [], autoRefunded: [] });

    const { container } = render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("manual-refund-task-queue"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("automatic-refund-notices"),
    ).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it("survives an older response that carries no automatic-refund list", async () => {
    // A cached client against a pre-#2750 route, or the route degraded: the
    // hand-back queue must still work rather than throw on a missing field.
    stubLoad({ tasks: [OPEN_TASK] });

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(screen.getByTestId("manual-refund-task-queue")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("automatic-refund-notices"),
    ).not.toBeInTheDocument();
  });

  it("shows no record when the load fails, rather than a stale one", async () => {
    stubLoad({}, false);

    render(<ManualRefundTaskQueue />);

    await waitFor(() =>
      expect(
        screen.queryByTestId("manual-refund-task-queue"),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("automatic-refund-notices"),
    ).not.toBeInTheDocument();
  });
});
