// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditMemberGuestSection } from "@/components/booking/edit-member-guest-section";

/**
 * MG4 (#2309): the edit path's member-guest section.
 *
 * The find panel itself is MG3's and has its own suite; what is tested here is
 * only what MG4 decided — which copy each reader gets, which route answers the
 * lookup, and the open/close behaviour that keeps a keyboard user oriented.
 */

const originalFetch = global.fetch;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
  global.fetch = originalFetch;
});

function renderSection(overrides: Partial<React.ComponentProps<typeof EditMemberGuestSection>> = {}) {
  const onAdd = vi.fn();
  render(
    <EditMemberGuestSection
      bookingId="bk-1"
      actingAsAdmin={false}
      openSearchEnabled={false}
      approvalRequired
      existingMemberIds={[]}
      atCapacity={false}
      addError={null}
      onAdd={onAdd}
      {...overrides}
    />,
  );
  return { onAdd };
}

describe("what each reader is told will happen", () => {
  it("promises a MEMBER that the other person is asked first, under the ask-first default", () => {
    renderSection();
    expect(
      screen.getByText(/emailed and asked first/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/held for them until they answer/i)).toBeInTheDocument();
  });

  it("promises a MEMBER the quieter outcome when the club runs notify-only", () => {
    renderSection({ approvalRequired: false });
    expect(screen.getByText(/straight away and emails them/i)).toBeInTheDocument();
    expect(screen.queryByText(/asked first/i)).not.toBeInTheDocument();
  });

  it("tells an ADMIN both halves of MG4-D-a: immediate, and the member IS told", () => {
    // The half that is easy to drop is the second one. An officer who thinks
    // this is a silent administrative action will use it as one.
    renderSection({ actingAsAdmin: true });
    const copy = screen.getByText(/added straight away and emailed to say so/i);
    expect(copy).toBeInTheDocument();
    expect(copy.textContent).toMatch(/not asked first/i);
  });

  it("offers an admin no choice about that email, because D-16 does not make it optional", () => {
    // A "…and email member" tick here would be a per-action opt-out over a
    // consent-adjacent notice, which owner decision D-16 rules out.
    renderSection({ actingAsAdmin: true });
    expect(screen.queryByText(/email member/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

describe("which route answers the lookup", () => {
  it("sends a member's email lookup to the member route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ candidates: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    renderSection();
    fireEvent.click(screen.getByRole("button", { name: /add member guest/i }));
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "sam@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "/api/members/guest-candidates/resolve",
    );
  });

  it("sends an admin's email lookup to the booking-scoped admin route instead", async () => {
    // The officer's lookup is gated and audited differently, so it must not go
    // through the member route — which would apply the member rate limits and
    // the member's privacy gate to somebody neither was written for.
    const fetchMock = vi.fn(async () => jsonResponse({ candidates: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    renderSection({ actingAsAdmin: true });
    fireEvent.click(screen.getByRole("button", { name: /add member guest/i }));
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "sam@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/admin/bookings/bk-1/member-guest-candidates");
    expect(url).toContain("mode=email");
  });
});

describe("opening, closing, and refusals", () => {
  it("renders no find panel until the trigger is pressed", () => {
    renderSection();
    expect(screen.queryByTestId("member-guest-find-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /add member guest/i }));
    expect(screen.getByTestId("member-guest-find-panel")).toBeInTheDocument();
  });

  it("returns focus to the trigger when the panel closes", () => {
    // Without this, Escape drops focus on document.body and a keyboard user is
    // stranded at the top of a 2,700-line panel (MG3's F5).
    renderSection();
    const trigger = screen.getByRole("button", { name: /add member guest/i });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(document.activeElement).toBe(trigger);
  });

  it("re-opens itself when the server refuses the add, so the reason lands beside the person", () => {
    // The add is optimistic and the refusal arrives on the quote that follows,
    // by which time the panel has closed. Showing D-8's one neutral sentence
    // above an empty search box is what MG3's F9 was about.
    const { rerender } = renderWithRerender();
    expect(screen.queryByTestId("member-guest-find-panel")).not.toBeInTheDocument();
    rerender("This member can't be added to this booking right now.");
    expect(screen.getByTestId("member-guest-find-panel")).toBeInTheDocument();
  });

  it("disables the trigger when the party is already at capacity", () => {
    renderSection({ atCapacity: true });
    expect(screen.getByRole("button", { name: /add member guest/i })).toBeDisabled();
  });
});

function renderWithRerender() {
  const onAdd = vi.fn();
  const props = {
    bookingId: "bk-1",
    actingAsAdmin: false,
    openSearchEnabled: false,
    approvalRequired: true,
    existingMemberIds: [] as string[],
    atCapacity: false,
    onAdd,
  };
  const view = render(<EditMemberGuestSection {...props} addError={null} />);
  return {
    rerender: (addError: string | null) =>
      view.rerender(<EditMemberGuestSection {...props} addError={addError} />),
  };
}
