// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BookingChangeRequestsPanel } from "@/components/admin/booking-requests/booking-change-requests-panel";

/**
 * #2562 review — the note split on the LOCKED-PERIOD half of the same table.
 *
 * `BookingChangeRequest` holds both kinds of row, and the two kinds are decided from
 * different officer panels. #2562 rewrote the policy-exception panel and then wrote
 * the invariant down as TABLE-WIDE (`prisma/schema.prisma` on `adminNotes`,
 * `docs/DOMAIN_INVARIANTS.md`) — but this panel's field was still headed just "Admin
 * notes", with no audience wording anywhere in the file, while writing the same
 * member-visible column that `/bookings/<id>` renders to the member verbatim. So the
 * surface whose label most invited the mistake was the one the remedy never reached:
 * an officer typing "third ask this month, do not encourage" into a box called
 * "Admin notes" had no warning and nowhere else to put it.
 *
 * These cases pin the fix at the surface: both fields, both audiences named before
 * the decision is submitted, and the two travelling as separate wire fields.
 */

vi.mock("sonner", () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function changeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    bookingId: "bk-1",
    requestedByMemberId: "m-1",
    status: "REQUESTED",
    requestedChanges: { requested: { summary: "check-out to 2026-05-24" } },
    reason: "Weather closed the road.",
    adminNotes: null,
    internalNotes: null,
    reviewedAt: null,
    createdAt: "2026-05-23T10:00:00.000Z",
    requestedBy: {
      id: "m-1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
    },
    reviewedBy: null,
    linkedModification: null,
    booking: {
      id: "bk-1",
      checkIn: "2026-05-23T00:00:00.000Z",
      checkOut: "2026-05-27T00:00:00.000Z",
      status: "COMPLETED",
      finalPriceCents: 12000,
      member: {
        id: "m-1",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
      },
      payment: null,
    },
    ...overrides,
  };
}

let listResponse: () => Response;
let fetchMock: ReturnType<typeof vi.fn>;

function installFetch() {
  listResponse = () =>
    jsonResponse({ data: [changeRequest()], page: 1, pageSize: 25, total: 1 });
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === "PATCH") {
      return jsonResponse({ id: "req-1", status: "REJECTED" });
    }
    if (url.includes("/api/admin/booking-change-requests")) return listResponse();
    return jsonResponse({});
  });
  global.fetch = fetchMock as unknown as typeof fetch;
}

beforeEach(() => {
  installFetch();
});

describe("the locked-period decision form names who reads what", () => {
  it("draws two fields, and names the audience of each before submission", async () => {
    render(<BookingChangeRequestsPanel />);
    expect(
      await screen.findByLabelText(/Explanation for the member/i),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Internal note/i)).toBeInTheDocument();
    // The label that caused the problem must be gone, not merely supplemented.
    expect(screen.queryByLabelText(/^Admin notes$/i)).toBeNull();
    expect(screen.getByText(/The member will see this/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Only admins see this. It is never shown to the member/i),
    ).toBeInTheDocument();
  });

  it("keeps both decisions unavailable until the MEMBER-facing note is written", async () => {
    render(<BookingChangeRequestsPanel />);
    const memberField = await screen.findByLabelText(/Explanation for the member/i);
    const reject = screen.getByRole("button", { name: "Reject" });
    const approve = screen.getByRole("button", {
      name: /Acknowledge as approved/i,
    });

    // AN UNTOUCHED FORM IS THE CASE THAT USED TO SLIP THROUGH. The old rule was
    // `reviewingId === request.id && !adminNotes.trim()`, so a row nobody had typed
    // into had both buttons live and could be decided with no member-facing
    // explanation at all — while the written invariant said the opposite.
    expect(reject).toBeDisabled();
    expect(approve).toBeDisabled();

    // An internal note alone must not unlock a decision: the member has to be told
    // something they can act on.
    fireEvent.change(screen.getByLabelText(/Internal note/i), {
      target: { value: "Third ask this month, do not encourage." },
    });
    expect(reject).toBeDisabled();
    expect(approve).toBeDisabled();

    // Whitespace is not an explanation.
    fireEvent.change(memberField, { target: { value: "   " } });
    expect(reject).toBeDisabled();
    expect(approve).toBeDisabled();

    fireEvent.change(memberField, {
      target: { value: "Those nights are already committed, sorry." },
    });
    expect(reject).not.toBeDisabled();
    expect(approve).not.toBeDisabled();
  });

  it("never carries one request's draft note onto another request", async () => {
    listResponse = () =>
      jsonResponse({
        data: [
          changeRequest(),
          changeRequest({
            id: "req-2",
            bookingId: "bk-2",
            requestedByMemberId: "m-2",
            requestedBy: {
              id: "m-2",
              firstName: "Bea",
              lastName: "Tui",
              email: "bea@example.com",
            },
            booking: {
              ...changeRequest().booking,
              id: "bk-2",
              member: {
                id: "m-2",
                firstName: "Bea",
                lastName: "Tui",
                email: "bea@example.com",
              },
            },
          }),
        ],
        page: 1,
        pageSize: 25,
        total: 2,
      });
    render(<BookingChangeRequestsPanel />);

    // Three inputs share one state slot, so a note typed on the first card used to
    // be POSTed onto whichever card the officer clicked next — and on this table the
    // member reads `adminNotes` verbatim, so Bea would have read a sentence written
    // about Ada's request.
    const memberFields = await screen.findAllByLabelText(
      /Explanation for the member/i,
    );
    fireEvent.change(memberFields[0], {
      target: { value: "Ada's road was closed, allowing it." },
    });
    fireEvent.change(screen.getAllByLabelText(/Internal note/i)[0], {
      target: { value: "Ada rings every month." },
    });

    // The second card owns no draft, so it cannot be decided at all.
    const secondReject = screen.getAllByRole("button", { name: "Reject" })[1];
    expect(secondReject).toBeDisabled();

    // And the first card still submits its own note, unchanged.
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]);
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(String(patch?.[0])).toContain("/req-1");
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toMatchObject({
        adminNotes: "Ada's road was closed, allowing it.",
        internalNotes: "Ada rings every month.",
      });
    });
    // Nothing was sent for the other member's request.
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          (init as RequestInit | undefined)?.method === "PATCH" &&
          String(url).includes("/req-2"),
      ),
    ).toHaveLength(0);
  });

  it("sends the two notes as separate fields", async () => {
    render(<BookingChangeRequestsPanel />);
    fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), {
      target: { value: "Those nights are already committed, sorry." },
    });
    fireEvent.change(screen.getByLabelText(/Internal note/i), {
      target: { value: "Third ask this month, do not encourage." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      expect(patch).toBeDefined();
      expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toMatchObject({
        status: "REJECTED",
        adminNotes: "Those nights are already committed, sorry.",
        internalNotes: "Third ask this month, do not encourage.",
      });
    });
  });

  it("omits a blank internal note rather than sending an empty string", async () => {
    render(<BookingChangeRequestsPanel />);
    fireEvent.change(await screen.findByLabelText(/Explanation for the member/i), {
      target: { value: "No room that weekend." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      );
      const body = JSON.parse(String((patch?.[1] as RequestInit).body));
      expect(body.internalNotes).toBeUndefined();
    });
  });
});

describe("a decided locked-period request shows which half the member has read", () => {
  it("labels the two notes separately", async () => {
    listResponse = () =>
      jsonResponse({
        data: [
          changeRequest({
            status: "REJECTED",
            reviewedAt: "2026-05-24T09:00:00.000Z",
            reviewedBy: { id: "officer-1", firstName: "Grace", lastName: "Hopper" },
            adminNotes: "Those nights are already committed, sorry.",
            internalNotes: "Third ask this month, do not encourage.",
          }),
        ],
        page: 1,
        pageSize: 25,
        total: 1,
      });
    render(<BookingChangeRequestsPanel />);
    expect(
      await screen.findByText(/Explanation the member can see/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Internal note — admins only, never shown to the member/i),
    ).toBeInTheDocument();
  });

  it("draws no internal-note block when the officer left none", async () => {
    listResponse = () =>
      jsonResponse({
        data: [
          changeRequest({
            status: "REJECTED",
            adminNotes: "No room that weekend.",
            internalNotes: null,
          }),
        ],
        page: 1,
        pageSize: 25,
        total: 1,
      });
    render(<BookingChangeRequestsPanel />);
    expect(await screen.findByText("No room that weekend.")).toBeInTheDocument();
    expect(screen.queryByText(/Internal note — admins only/i)).toBeNull();
  });
});
