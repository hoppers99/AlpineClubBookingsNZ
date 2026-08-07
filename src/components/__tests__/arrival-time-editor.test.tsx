// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ArrivalTimeEditor } from "@/components/arrival-time-editor";

// #2621 — the editor used to LIE.
//
// It saved on every change of the dropdown and then rendered a green "Saved"
// **without ever looking at the response**. `fetch` only rejects on a network
// failure, so a 400 (the check-in date has passed) and a 403 (a Booking Officer
// permission the member does not have) both resolved normally and both printed
// "Saved" beside a value the server had refused. The member closed the page
// believing the lodge knew when they were coming; on reload the old value came
// back with no explanation.
//
// These tests are the contract that made that impossible: nothing is sent until
// the member presses Save, "Saved" appears only after a response the server
// called successful, and a refusal shows the server's own message.

describe("ArrivalTimeEditor (#2621)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderEditor(initialTime: string | null = null) {
    return render(
      <ArrivalTimeEditor
        bookingId="booking-1"
        initialTime={initialTime}
        canEdit
      />
    );
  }

  it("sends nothing on change — the value is staged until Save is pressed", () => {
    renderEditor();
    const select = screen.getByLabelText("Expected arrival time");

    fireEvent.change(select, { target: { value: "17:30" } });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("saves on press and only then says Saved", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    renderEditor();

    fireEvent.change(screen.getByLabelText("Expected arrival time"), {
      target: { value: "17:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save arrival time/i }));

    await waitFor(() => expect(screen.getByText("Saved")).toBeDefined());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/bookings/booking-1/arrival-time");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ expectedArrivalTime: "17:30" });
  });

  it("REFUSAL: a 403 shows the server's message and never says Saved", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "Forbidden" }),
    });
    renderEditor();

    fireEvent.change(screen.getByLabelText("Expected arrival time"), {
      target: { value: "17:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save arrival time/i }));

    await waitFor(() => expect(screen.getByText("Forbidden")).toBeDefined());
    // The whole point: the old editor printed this in green.
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("REFUSAL: a 400 shows the server's reason and never says Saved", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: "Cannot update arrival time after check-in date has passed",
      }),
    });
    renderEditor();

    fireEvent.change(screen.getByLabelText("Expected arrival time"), {
      target: { value: "17:30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save arrival time/i }));

    await waitFor(() =>
      expect(
        screen.getByText("Cannot update arrival time after check-in date has passed")
      ).toBeDefined()
    );
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("a refused save leaves the confirmed value where it was — Save stays offered", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: "Forbidden" }),
    });
    renderEditor("09:30");

    fireEvent.change(screen.getByLabelText("Expected arrival time"), {
      target: { value: "17:30" },
    });
    const button = screen.getByRole("button", { name: /save arrival time/i });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText("Forbidden")).toBeDefined());
    // `savedTime` did not move, so the staged value still differs from it and
    // the member can retry rather than being told there is nothing to save.
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears with DELETE when the member picks Not sure", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    renderEditor("17:30");

    fireEvent.change(screen.getByLabelText("Expected arrival time"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save arrival time/i }));

    await waitFor(() => expect(screen.getByText("Saved")).toBeDefined());
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("offers no Save until something changes, and none again once it is saved", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    renderEditor("09:30");

    expect(
      (screen.getByRole("button", { name: /save arrival time/i }) as HTMLButtonElement)
        .disabled
    ).toBe(true);

    fireEvent.change(screen.getByLabelText("Expected arrival time"), {
      target: { value: "17:30" },
    });
    const button = screen.getByRole("button", {
      name: /save arrival time/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(screen.getByText("Saved")).toBeDefined());
    // Saved is now the confirmed value, so there is nothing left to send.
    expect(button.disabled).toBe(true);
  });

  it("associates its label and its hint with the control (#2621 accessibility)", () => {
    renderEditor();
    // `getByLabelText` above already proves the label association; this pins the
    // description, which used to have no way to reach the control at all.
    const select = screen.getByLabelText("Expected arrival time");
    const describedBy = select.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain(
      "hut leader"
    );
  });

  it("read-only mode shows the 12-hour form, or 'Not set'", () => {
    // Two separate mounts, not a rerender: `initialTime` seeds `useState`, so a
    // rerender with a different prop would keep the first value and prove
    // nothing about the second case.
    const first = render(
      <ArrivalTimeEditor
        bookingId="booking-1"
        initialTime="17:30"
        canEdit={false}
      />
    );
    expect(screen.getByText("5:30 PM")).toBeDefined();
    first.unmount();

    render(
      <ArrivalTimeEditor
        bookingId="booking-1"
        initialTime={null}
        canEdit={false}
      />
    );
    expect(screen.getByText("Not set")).toBeDefined();
  });
});
