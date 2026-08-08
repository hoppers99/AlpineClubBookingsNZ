// @vitest-environment jsdom

// #2654. The requested-room editor used to write on every change of the picker
// and then say "Saved" without ever looking at the response.
//
// `fetch` rejects only on a network failure, so every refusal the server can
// raise — 400 from the room validator, 403 from the ownership check, 409 when
// the lodge has already allocated the beds — resolved normally and was reported
// as a success. It is now staged with an explicit Save, matching the
// arrival-time editor beside it on the same booking page.
//
// These tests pin both halves of the honest behaviour: nothing is written until
// the member presses Save, and the outcome shown afterwards matches the outcome
// the server gave, in the server's own words — with the staged pick left on
// screen for a retry when the server says no.

import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

// #2664: the picker's options now come from a BOOKING-SCOPED read, so the
// server derives the lodge (and the authority) from the booking being edited
// rather than listing every lodge the caller happens to be eligible to book.
// Every render below is on `booking-1`, so this is the URL the mount fires.
const OPTIONS_URL = "/api/bookings/booking-1/requested-room/options";

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
    (call) => String(call[0]) !== OPTIONS_URL,
  );
}

function saveButton(): HTMLElement {
  return screen.getByRole("button", { name: /save preferred room|saving/i });
}

/** Stage a choice. In the reworked editor this writes nothing by itself. */
async function selectRoom(value: string) {
  const select = await screen.findByLabelText("Preferred room select");
  fireEvent.change(select, { target: { value } });
}

/** Wait for the mount-time picker load, so the next call would be a write. */
async function awaitRoomsLoad() {
  await waitFor(() => {
    expect(fetchMock).toHaveBeenCalledWith(OPTIONS_URL);
  });
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
  it("stages the choice and writes nothing until Save is pressed", async () => {
    // The whole point of the rework: the member's pick is a proposal, not a
    // write. An auto-save has no obvious place to report that it failed, which
    // is how "Saved" came to be printed over a refusal in the first place.
    fetchMock
      .mockResolvedValueOnce(roomsCall())
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: "booking-1",
          requestedRoomId: CEDAR.id,
          requestedRoom: { ...CEDAR },
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

    await awaitRoomsLoad();
    expect(saveButton()).toBeDisabled();

    await selectRoom(CEDAR.id);

    // Staged, and still not written.
    expect(await screen.findByLabelText("Preferred room select")).toHaveValue(
      CEDAR.id,
    );
    expect(writeCalls()).toHaveLength(0);
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(saveButton()).toBeEnabled();

    fireEvent.click(saveButton());

    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(writeCalls()).toHaveLength(1);
  });

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
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Forbidden");
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    // The staged pick stays for the retry; only the stored room is unmoved.
    expect(await screen.findByLabelText("Preferred room select")).toHaveValue(
      CEDAR.id,
    );
    expect(saveButton()).toBeEnabled();
    // The refusal is announced with the control it belongs to.
    expect(screen.getByTestId("select-trigger")).toHaveAttribute(
      "aria-describedby",
      screen.getByRole("status").getAttribute("id"),
    );
  });

  it("surfaces the bed-allocation refusal verbatim and keeps the staged room for retry", async () => {
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
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(LOCKED);
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    // #2654 acceptance criterion 1: the staged value survives for retry. The
    // booking still holds no preference, but the member does not have to find
    // their room again to try a second time.
    expect(await screen.findByLabelText("Preferred room select")).toHaveValue(
      ALPINE.id,
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
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Could not save your room request. Please try again.",
      );
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  /**
   * #2668. This used to assert the editor said "Your room request was not
   * saved." It cannot know that. `fetch` rejects both when the request never
   * arrived AND when the server processed it and the connection dropped before
   * the answer came back — and in the second case the DELETE has committed, so
   * telling the member nothing happened sends them back to redo a change the
   * club's records already hold. The wording is pinned here so the confident
   * phrasing cannot come back.
   */
  it("claims no outcome it could not read when the response never arrives", async () => {
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
    fireEvent.click(saveButton());

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "The service response could not be read, so we could not verify whether your room request was saved. Reload the page to see what the club's records hold before trying again.",
      );
    });
    // The specific claim the client is not entitled to make.
    expect(screen.getByRole("status")).not.toHaveTextContent("was not saved");
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    // The staged clear stays put: a re-press re-sends the same idempotent call,
    // and reverting the picker would put a value on screen the database may no
    // longer hold — the drift #2658 removed from this component.
    expect(await screen.findByLabelText("Preferred room select")).toHaveValue(
      "none",
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
    fireEvent.click(saveButton());

    expect(await screen.findByText("Saved")).toBeInTheDocument();
    // The chip follows the server-confirmed room, so it can only appear because
    // the answer said `active: false` — the option that was sent said active.
    expect(
      screen.getByText("Room no longer active — treated as no preference"),
    ).toBeInTheDocument();
    expect(writeCalls()).toHaveLength(1);
    expect(writeCalls()[0][1]).toMatchObject({ method: "PUT" });
    // The confirmed value is now the staged value, so Save re-arms only on a
    // fresh change.
    expect(saveButton()).toBeDisabled();
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
    fireEvent.click(saveButton());

    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(writeCalls()).toHaveLength(1);
    expect(writeCalls()[0][1]).toMatchObject({ method: "DELETE" });
  });

  it("cannot save when the choice is the room already stored (#2143 dirty gate)", async () => {
    fetchMock.mockResolvedValue(roomsCall());

    render(
      <RequestedRoomEditor
        bookingId="booking-1"
        initialRoom={ALPINE}
        canEdit
        endpoint="/api/bookings/booking-1/requested-room"
      />,
    );

    await awaitRoomsLoad();
    await selectRoom(CEDAR.id);
    expect(saveButton()).toBeEnabled();

    await selectRoom(ALPINE.id);

    expect(saveButton()).toBeDisabled();
    fireEvent.click(saveButton());
    expect(writeCalls()).toHaveLength(0);
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
    expect(screen.queryByText("Saving...")).not.toBeInTheDocument();
  });

  it("cannot send an empty clear when the booking has no preference to begin with", async () => {
    // What "clear" means with nothing saved yet: nothing. Staging "No
    // preference" on a booking that already has none is not a change, so the
    // DELETE that would write an audit entry asserting one is unreachable.
    fetchMock.mockResolvedValue(roomsCall());

    render(
      <RequestedRoomEditor
        bookingId="booking-1"
        initialRoom={null}
        canEdit
        endpoint="/api/bookings/booking-1/requested-room"
      />,
    );

    await awaitRoomsLoad();
    expect(saveButton()).toBeDisabled();

    await selectRoom("none");

    expect(saveButton()).toBeDisabled();
    fireEvent.click(saveButton());
    expect(writeCalls()).toHaveLength(0);
  });
});
