// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditMemberGuestFinder } from "@/components/booking/edit-member-guest-section";

/**
 * MG4 (#2309): the edit path's member-guest finder.
 *
 * The find panel itself is MG3's and has its own suite; what is tested here is
 * only what MG4 decided — which copy each reader gets, which route answers the
 * lookup, and who is (and is not) promised a name search.
 *
 * The TRIGGER is not here. Owner sign-off (1 Aug 2026) put it in the Guests
 * card header beside "+ Add Non-Member Guest", which makes it the edit panel's
 * to own — the same split `guests-step.tsx` has for the wizard. Its behaviour is
 * covered where it lives.
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

function renderFinder(
  overrides: Partial<React.ComponentProps<typeof EditMemberGuestFinder>> = {},
) {
  const onAdd = vi.fn();
  const onCancel = vi.fn();
  render(
    <EditMemberGuestFinder
      bookingId="bk-1"
      actingAsAdmin={false}
      openSearchEnabled={false}
      approvalRequired
      existingMemberIds={[]}
      atCapacity={false}
      addError={null}
      refusedCandidate={null}
      onAdd={onAdd}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onAdd, onCancel };
}

describe("what each reader is told will happen", () => {
  it("promises a MEMBER that the other person is asked first, under the ask-first default", () => {
    renderFinder();
    expect(screen.getByText(/emailed and asked first/i)).toBeInTheDocument();
    expect(
      screen.getByText(/held for them until they answer/i),
    ).toBeInTheDocument();
  });

  it("promises a MEMBER the quieter outcome when the club runs notify-only", () => {
    renderFinder({ approvalRequired: false });
    expect(screen.getByText(/straight away and emails them/i)).toBeInTheDocument();
    expect(screen.queryByText(/asked first/i)).not.toBeInTheDocument();
  });

  it("tells an ADMIN both halves of MG4-D-a: immediate, and the member IS told", () => {
    // The half that is easy to drop is the second one. An officer who thinks
    // this is a silent administrative action will use it as one.
    renderFinder({ actingAsAdmin: true });
    expect(screen.getByTestId("edit-member-guest-intent")).toHaveTextContent(
      "This member will be added immediately and told by email.",
    );
  });

  it("offers an admin no choice about that email, because D-16 does not make it optional", () => {
    // A "…and email member" tick here would be a per-action opt-out over a
    // consent-adjacent notice, which owner decision D-16 rules out.
    renderFinder({ actingAsAdmin: true });
    expect(screen.queryByText(/email member/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });
});

describe("the admin reach hint", () => {
  it("tells an officer who HAS name search what their search reaches", () => {
    renderFinder({ actingAsAdmin: true, openSearchEnabled: true });
    expect(
      screen.getByText(
        "Admins can search every active member by name, including under-18s.",
      ),
    ).toBeInTheDocument();
  });

  it("withholds it from the #1376 officer, who would get a 404 on the name mode", () => {
    // The one place this surface could lie about its own gate: promising a
    // directory type-ahead to a Booking Officer whose role deliberately carries
    // no membership access. Their fallback is the exact-email box.
    renderFinder({ actingAsAdmin: true, openSearchEnabled: false });
    expect(screen.queryByText(/including under-18s/i)).not.toBeInTheDocument();
  });

  it("never shows it to a member, whatever the club's own search setting says", () => {
    // It is a statement about ADMIN reach. Shown to a member on a club that
    // turned open search on, it would misdescribe what THEY can see.
    renderFinder({ actingAsAdmin: false, openSearchEnabled: true });
    expect(screen.queryByText(/Admins can search/i)).not.toBeInTheDocument();
  });
});

describe("which route answers the lookup", () => {
  function findByEmail() {
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "sam@example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
  }

  it("sends a member's email lookup to the member route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ candidates: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    renderFinder();
    findByEmail();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url] = fetchMock.mock.calls[0] as unknown as [unknown];
    expect(String(url)).toBe("/api/members/guest-candidates/resolve");
  });

  it("sends an admin's email lookup to the booking-scoped admin route, in the BODY", async () => {
    // Two properties. The officer's lookup is gated and audited differently, so
    // it must not go through the member route — which would apply the member
    // rate limits and the member's privacy gate to somebody neither was written
    // for. And the address travels in a POST body, not a query string: a GET
    // would put another member's email into the access log, the browser history
    // and the `Referer` of everything the page loads next, which is exactly why
    // the member route is a POST too.
    const fetchMock = vi.fn(async () => jsonResponse({ candidates: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;

    renderFinder({ actingAsAdmin: true });
    findByEmail();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      unknown,
      RequestInit,
    ];
    expect(String(url)).toBe(
      "/api/admin/bookings/bk-1/member-guest-candidates",
    );
    expect(String(url)).not.toContain("email");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ email: "sam@example.com" });
  });
});

/*
 * REFUSALS ARE NOT TESTED HERE, DELIBERATELY, and the reason is the finding
 * that removed the test that used to be.
 *
 * `addError` and `refusedCandidate` are props: handing them straight to this
 * component and asserting they render proves only that the props are wired,
 * which was never in doubt. What WAS in doubt — and was in fact broken — is
 * whether the edit panel ever puts the component on screen at a moment when
 * they are set: "Add to booking" closes the finder, and the server's refusal
 * only arrives on the debounced quote that follows, by which time this
 * component is unmounted and neither prop renders anywhere at all.
 *
 * So the refusal is covered where the sequence lives, in
 * `src/components/__tests__/edit-booking-panel-member-guest.test.tsx`, driven
 * through the real open → add → close → refusal path.
 */
