// @vitest-environment jsdom

// #2664. The requested-room picker used to load `/api/bookings/rooms` with no
// scope at all.
//
// That endpoint's no-`lodgeId` mode returns active rooms across EVERY lodge the
// caller is personally eligible to book, so on a multi-lodge club the editor
// offered a lodge B room while editing a lodge A booking — and
// `writeRequestedRoom()` then correctly refused the save under its lock with
// "Requested room belongs to a different lodge than the booking". The member met
// it as a control that simply did not work. The same unscoped read also filtered
// a Booking Officer's choices by that officer's OWN member booking eligibility,
// even though their write is authorised through the booking/admin path.
//
// These tests pin the component half of the fix: the editor asks the
// BOOKING-SCOPED read, on both the member and the staff path, and never the
// global list. The scoping itself is the server's job and is pinned in
// src/app/api/bookings/[id]/requested-room/__tests__/options-route.test.ts —
// what is asserted here is that the component asks the question that can be
// scoped, and offers nothing beyond the answer it gets.

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";

import { RequestedRoomEditor } from "../requested-room-editor";

// Radix Select does not open in jsdom; a native select keeps the value binding
// and the rendered option list assertable.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value?: string;
    onValueChange?: (value: string) => void;
    disabled?: boolean;
    children?: React.ReactNode;
  }) => (
    <select
      aria-label="Preferred room select"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: (props: Record<string, unknown>) => (
    <span data-testid="select-trigger" {...props} />
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children?: React.ReactNode;
  }) => <option value={value}>{children}</option>,
}));

const LODGE_A_BOOKING = "booking-lodge-a";
const OPTIONS_URL = `/api/bookings/${LODGE_A_BOOKING}/requested-room/options`;

// What the booking-scoped read answers for a lodge A booking: lodge A's active
// rooms, and nothing else. Cedar (lodge B) is deliberately absent — that is the
// server's scoping, and the point of these tests is that the component has no
// other source it could pull Cedar from.
const LODGE_A_OPTIONS = {
  enabled: true,
  rooms: [{ id: "room-alpine", name: "Alpine", bedCount: 4 }],
};

// What the OLD unscoped read answered, kept live in the fetch stub below. This
// is the defect itself, reproducible: a member eligible for both lodges got
// lodge B's Cedar back from `/api/bookings/rooms`, and the picker offered it.
// Serving it from that URL is what makes "no Cedar in the picker" an assertion
// that can actually fail — a component that regressed to the old URL gets Cedar
// and lights the test up, rather than passing because no fixture contains it.
const UNSCOPED_EVERY_LODGE = {
  enabled: true,
  rooms: [
    { id: "room-alpine", name: "Alpine", bedCount: 4 },
    { id: "room-cedar", name: "Cedar", bedCount: 2 },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function optionValues(): string[] {
  const select = screen.getByLabelText("Preferred room select");
  return within(select)
    .getAllByRole("option")
    .map((option) => (option as HTMLOptionElement).value);
}

/**
 * Every call the component made to the old unscoped endpoint, matched on PREFIX
 * rather than on the exact string. A regression that reached for
 * `/api/bookings/rooms?lodgeId=...` is the same defect with a query string on
 * it, and an exact-equality negative would wave it through.
 */
function unscopedRoomCalls(): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith("/api/bookings/rooms"));
}

beforeEach(() => {
  // The stub answers BOTH endpoints, so which one the component asks decides
  // what it gets. That is what turns these tests into a reproduction of the
  // defect rather than a restatement of the fixture.
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === OPTIONS_URL) {
      return Promise.resolve(jsonResponse(200, LODGE_A_OPTIONS));
    }
    if (url.startsWith("/api/bookings/rooms")) {
      return Promise.resolve(jsonResponse(200, UNSCOPED_EVERY_LODGE));
    }
    return Promise.resolve(jsonResponse(404, { error: "Not found" }));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RequestedRoomEditor room-options scope (#2664)", () => {
  it("asks the booking-scoped read, never the unscoped global room list", async () => {
    render(
      <RequestedRoomEditor
        bookingId={LODGE_A_BOOKING}
        initialRoom={null}
        canEdit
        endpoint={`/api/bookings/${LODGE_A_BOOKING}/requested-room`}
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(OPTIONS_URL);
    });
    // The old call, in the form that caused the defect. It must be gone: any
    // request without the booking in it cannot be lodge-scoped by the server,
    // with or without a `lodgeId` on the query string.
    expect(unscopedRoomCalls()).toEqual([]);
  });

  it("asks the same booking-scoped read on the staff path", async () => {
    // A Booking Officer's WRITE goes to the admin route; the options read is the
    // same booking-scoped URL, and the server authorises it on the booking (the
    // officer's `bookings:edit`), not on the officer's personal ability to book
    // that lodge. One read for both paths is what makes that possible.
    render(
      <RequestedRoomEditor
        bookingId={LODGE_A_BOOKING}
        initialRoom={null}
        canEdit
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(OPTIONS_URL);
    });
    expect(unscopedRoomCalls()).toEqual([]);
  });

  it("offers no lodge B room on a lodge A booking, to a member eligible for both", async () => {
    // The headline case, reproduced end to end at the component: the stub is
    // still serving Cedar on `/api/bookings/rooms`, exactly as the real endpoint
    // did for a member with no booking restrictions. The only thing keeping
    // Cedar out of this picker is which URL the component asks.
    render(
      <RequestedRoomEditor
        bookingId={LODGE_A_BOOKING}
        initialRoom={null}
        canEdit
        endpoint={`/api/bookings/${LODGE_A_BOOKING}/requested-room`}
      />,
    );

    await waitFor(() => {
      expect(optionValues()).toEqual(["none", "room-alpine"]);
    });
    expect(optionValues()).not.toContain("room-cedar");
  });

  it("shows an already-stored inactive room as the stored value, not as a fresh choice", async () => {
    // A booking may hold a room the club has since retired. It must still be
    // visible as what the records HOLD — labelled inactive, with the chip beside
    // it — while the fresh choices stay exactly the active rooms the
    // booking-scoped read returned.
    render(
      <RequestedRoomEditor
        bookingId={LODGE_A_BOOKING}
        initialRoom={{ id: "room-attic", name: "Attic", active: false }}
        canEdit
        endpoint={`/api/bookings/${LODGE_A_BOOKING}/requested-room`}
      />,
    );

    await waitFor(() => {
      expect(optionValues()).toEqual(["none", "room-attic", "room-alpine"]);
    });
    expect(screen.getByLabelText("Preferred room select")).toHaveValue(
      "room-attic",
    );
    expect(screen.getByText("Attic (inactive)")).toBeInTheDocument();
    expect(
      screen.getByText("Room no longer active — treated as no preference"),
    ).toBeInTheDocument();
    // It is the stored value, so re-picking it is not a change and cannot be
    // saved back as if it were a fresh selection.
    fireEvent.change(screen.getByLabelText("Preferred room select"), {
      target: { value: "room-attic" },
    });
    expect(
      screen.getByRole("button", { name: /save preferred room/i }),
    ).toBeDisabled();
  });

  it("loads nothing at all when the viewer cannot edit", async () => {
    render(
      <RequestedRoomEditor
        bookingId={LODGE_A_BOOKING}
        initialRoom={null}
        canEdit={false}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("No preference")).toBeInTheDocument();
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
