// @vitest-environment jsdom

// #2654. The requested-room editor auto-saves on every change, so the only
// thing standing between a member and a silent data loss is what it says after
// the write. It used to say "Saved" without ever looking at the response.
//
// `fetch` rejects only on a network failure, so every refusal the server can
// raise — 400 from the room validator, 403 from the ownership check, 409 when
// the lodge has already allocated the beds — resolved normally and was reported
// as a success. These tests pin the honest behaviour: the outcome shown matches
// the outcome the server gave, in the server's own words, and the control ends
// up showing the room that is actually stored.

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type React from "react";

import { RequestedRoomEditor } from "../requested-room-editor";

// Radix Select does not open in jsdom; a native select keeps the value binding
// and `onValueChange` testable. The trigger is kept as a real element so the
// error's `aria-describedby` wiring can be asserted rather than assumed.
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

const ALPINE = { id: "room-alpine", name: "Alpine", active: true };
const CEDAR = { id: "room-cedar", name: "Cedar", active: true };

const ROOMS_RESPONSE = {
  rooms: [
    { id: ALPINE.id, name: ALPINE.name, bedCount: 4 },
    { id: CEDAR.id, name: CEDAR.name, bedCount: 2 },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** The picker load the component fires on mount; never the write under test. */
function roomsCall(): Response {
  return jsonResponse(200, ROOMS_RESPONSE);
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Every write call — i.e. everything that is not the picker's own room load. */
function writeCalls() {
  return fetchMock.mock.calls.filter(
    (call) => String(call[0]) !== "/api/bookings/rooms",
  );
}

async function selectRoom(value: string) {
  const select = await screen.findByLabelText("Preferred room select");
  const { fireEvent } = await import("@testing-library/react");
  fireEvent.change(select, { target: { value } });
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RequestedRoomEditor save honesty (#2654)", () => {
  it("never says Saved when the server refuses, and shows the server's own words", async () => {
    fetchMock
      .mockResolvedValueOnce(roomsCall())
      .mockResolvedValueOnce(
        jsonResponse(403, {
          error: "Forbidden",
        }),
      );

    render(
      <RequestedRoomEditor
        bookingId="booking-1"
        initialRoom={ALPINE}
        canEdit
        endpoint="/api/bookings/booking-1/requested-room"
      />,
    );

    await selectRoom(CEDAR.id);

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Forbidden");
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    // The control shows the room that is actually stored, not the refused one.
    expect(await screen.findByLabelText("Preferred room select")).toHaveValue(
      ALPINE.id,
    );
    // The refusal is announced with the control it belongs to.
    expect(screen.getByTestId("select-trigger")).toHaveAttribute(
      "aria-describedby",
      screen.getByRole("status").getAttribute("id"),
    );
  });

  it("surfaces the bed-allocation refusal verbatim rather than reporting success", async () => {
    // The 409 `writeRequestedRoom` raises once the lodge has approved beds. It
    // is the refusal a member is most likely to meet, and the one where being
    // told "Saved" is most damaging — they would arrive expecting that room.
    const LOCKED =
      "Your beds have been allocated by the lodge and can no longer be changed here.";
    fetchMock
      .mockResolvedValueOnce(roomsCall())
      .mockResolvedValueOnce(jsonResponse(409, { error: LOCKED }));

    render(
      <RequestedRoomEditor
        bookingId="booking-1"
        initialRoom={null}
        canEdit
        endpoint="/api/bookings/booking-1/requested-room"
      />,
    );

    await selectRoom(ALPINE.id);

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(LOCKED);
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Preferred room select")).toHaveValue(
      "none",
    );
  });

  it("falls back to plain words when the refusal carries no JSON body", async () => {
    fetchMock.mockResolvedValueOnce(roomsCall()).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    render(
      <RequestedRoomEditor
        bookingId="booking-1"
        initialRoom={null}
        canEdit
        endpoint="/api/bookings/booking-1/requested-room"
      />,
    );

    await selectRoom(ALPINE.id);

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Could not save your room request. Please try again.",
      );
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("says nothing was saved when the request never reaches the server", async () => {
    fetchMock
      .mockResolvedValueOnce(roomsCall())
      .mockRejectedValueOnce(new Error("network down"));

    render(
      <RequestedRoomEditor
        bookingId="booking-1"
        initialRoom={ALPINE}
        canEdit
        endpoint="/api/bookings/booking-1/requested-room"
      />,
    );

    await selectRoom("none");

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Could not reach the server. Your room request was not saved.",
      );
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(await screen.findByLabelText("Preferred room select")).toHaveValue(
      ALPINE.id,
    );
  });

  it("says Saved only on a success, and takes the stored room from the answer", async () => {
    // The server is the authority on what it stored: it answers with the room
    // row, including whether it is still active, so an inactive room the writer
    // deliberately keeps is shown as inactive instead of as a fresh choice.
    fetchMock.mockResolvedValueOnce(roomsCall()).mockResolvedValueOnce(
      jsonResponse(200, {
        id: "booking-1",
        requestedRoomId: CEDAR.id,
        requestedRoom: { id: CEDAR.id, name: CEDAR.name, active: false },
      }),
    );

    render(
      <RequestedRoomEditor
        bookingId="booking-1"
        initialRoom={null}
        canEdit
        endpoint="/api/bookings/booking-1/requested-room"
      />,
    );

    await selectRoom(CEDAR.id);

    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(
      screen.getByText("Room no longer active — treated as no preference"),
    ).toBeInTheDocument();
    expect(writeCalls()).toHaveLength(1);
    expect(writeCalls()[0][1]).toMatchObject({ method: "PUT" });
  });

  it("clears the request with DELETE and reports the cleared answer", async () => {
    fetchMock.mockResolvedValueOnce(roomsCall()).mockResolvedValueOnce(
      jsonResponse(200, {
        id: "booking-1",
        requestedRoomId: null,
        requestedRoom: null,
      }),
    );

    render(
      <RequestedRoomEditor
        bookingId="booking-1"
        initialRoom={ALPINE}
        canEdit
        endpoint="/api/bookings/booking-1/requested-room"
      />,
    );

    await selectRoom("none");

    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(writeCalls()).toHaveLength(1);
    expect(writeCalls()[0][1]).toMatchObject({ method: "DELETE" });
  });

  it("fires no write when the choice is the room already stored (#2143 dirty gate)", async () => {
    fetchMock.mockResolvedValue(roomsCall());

    render(
      <RequestedRoomEditor
        bookingId="booking-1"
        initialRoom={ALPINE}
        canEdit
        endpoint="/api/bookings/booking-1/requested-room"
      />,
    );

    // Wait for the picker load so the only remaining call would be a write.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/bookings/rooms");
    });

    await selectRoom(ALPINE.id);

    expect(writeCalls()).toHaveLength(0);
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(screen.queryByText("Saving...")).not.toBeInTheDocument();
  });

  it("fires no write when a booking with no preference re-picks No preference", async () => {
    fetchMock.mockResolvedValue(roomsCall());

    render(
      <RequestedRoomEditor
        bookingId="booking-1"
        initialRoom={null}
        canEdit
        endpoint="/api/bookings/booking-1/requested-room"
      />,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/bookings/rooms");
    });

    await selectRoom("none");

    expect(writeCalls()).toHaveLength(0);
  });
});
