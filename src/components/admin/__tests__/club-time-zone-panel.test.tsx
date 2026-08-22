// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClubTimeZonePanel } from "@/components/admin/club-time-zone-panel";

/*
  The club-timezone maintenance panel (CT-1, #2989; epic #2988).

  Three things are being pinned, and only the first is ordinary UI behaviour:

  1. STAGED EDITING. The panel mounts read-only, and choosing a zone from the
     selector persists NOTHING. `docs/ARCHITECTURE.md` -> "Admin/member layer"
     is the rule; the failure it prevents is an operator browsing the list of 418
     zones and changing the club's civil time by scrolling.

  2. THE ACKNOWLEDGEMENT REALLY GATES SAVE, and the consequences it acknowledges
     are on the screen in plain English. A confirmation the operator cannot fail
     to satisfy is decoration.

  3. THE BROWSER NEVER DECIDES THE TIMEZONE. `Intl.DateTimeFormat()
     .resolvedOptions()` — the viewer's own clock — is spied on and must never be
     consulted, because a panel that seeded itself from the reader's machine
     would show a London admin a different club than an Ohakune one and would
     offer to "correct" the club's setting to the reader's own zone.
*/

const SERVER_STATE = {
  timeZone: "Pacific/Auckland",
  source: "persisted" as const,
  updatedAt: "2026-06-30T21:30:00.000Z",
  updatedByName: "Ada Lovelace",
};

let fetchMock: ReturnType<typeof vi.fn>;
let resolvedOptionsSpy: ReturnType<typeof vi.spyOn>;

function respondWith(state: unknown) {
  return {
    ok: true,
    json: async () => ({ state, changed: true }),
    text: async () => JSON.stringify({ state }),
  };
}

beforeEach(() => {
  fetchMock = vi.fn(async (_url: unknown, init?: { method?: string }) =>
    init?.method === "PUT"
      ? respondWith({ ...SERVER_STATE, timeZone: "Pacific/Chatham" })
      : respondWith(SERVER_STATE),
  );
  vi.stubGlobal("fetch", fetchMock);
  resolvedOptionsSpy = vi.spyOn(
    Intl.DateTimeFormat.prototype,
    "resolvedOptions",
  );
});

afterEach(() => {
  resolvedOptionsSpy.mockRestore();
  vi.unstubAllGlobals();
});

/** Render and wait for the server-supplied state to arrive. */
async function renderPanel() {
  render(<ClubTimeZonePanel />);
  await screen.findByTestId("current-club-time-zone");
}

function putCalls() {
  return fetchMock.mock.calls.filter(
    (call) => (call[1] as { method?: string } | undefined)?.method === "PUT",
  );
}

function saveButton() {
  return screen.getByRole("button", { name: /Save time zone/ });
}

describe("ClubTimeZonePanel", () => {
  it("renders the zone the server supplied, and asks the server for it", async () => {
    await renderPanel();

    expect(screen.getByTestId("current-club-time-zone").textContent).toBe(
      "Pacific/Auckland",
    );
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "/api/admin/club-time-zone",
    );
    // Who changed it, and when — spelled in the club's own configured zone.
    expect(screen.getByText(/Ada Lovelace/)).not.toBeNull();
  });

  it("says so when the club has not chosen a zone yet", async () => {
    fetchMock.mockImplementation(async () =>
      respondWith({
        timeZone: "Pacific/Auckland",
        source: "default",
        updatedAt: null,
        updatedByName: null,
      }),
    );
    await renderPanel();

    // The provenance word the operator guide uses, verbatim.
    expect(screen.getByText("Default")).not.toBeNull();
    expect(
      screen.getByText(/Saving below records the club's own choice/),
    ).not.toBeNull();
    expect(screen.queryByText(/Last changed/)).toBeNull();
  });

  it("never asks the viewer's own clock what the timezone is", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));

    // The list of CHOICES may come from this runtime. The DECISION may not:
    // resolvedOptions() is how a browser would report its own zone, and nothing
    // in the panel is allowed to consult it.
    expect(resolvedOptionsSpy).not.toHaveBeenCalled();
    // …and the panel is genuinely rendering, so the assertion is not vacuous.
    expect(screen.getByLabelText("Time zone")).not.toBeNull();
  });

  it("persists nothing when a zone is merely selected", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));

    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "Pacific/Chatham" },
    });

    expect(putCalls()).toHaveLength(0);
    // The read-only heading still shows the SAVED zone, not the selection.
    expect(screen.getByTestId("current-club-time-zone").textContent).toBe(
      "Pacific/Auckland",
    );
  });

  it("keeps Save disabled until the acknowledgement is ticked", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "Pacific/Chatham" },
    });

    expect(saveButton().hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("checkbox"));

    expect(saveButton().hasAttribute("disabled")).toBe(false);
  });

  it("lets the club RECORD the zone it is already effectively on", async () => {
    // The state a fresh install and an upgraded one both arrive in: the answer is
    // coming from `TZ` or the shipped default, and recording it is the whole
    // point of CT-1 — so Save must not be disabled just because the zone on
    // screen is the one already displayed.
    fetchMock.mockImplementation(async (_u: unknown, init?: { method?: string }) =>
      init?.method === "PUT"
        ? respondWith({ ...SERVER_STATE, source: "persisted" })
        : respondWith({
            timeZone: "Pacific/Auckland",
            source: "environment",
            updatedAt: null,
            updatedByName: null,
          }),
    );
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.click(screen.getByRole("checkbox"));

    expect(screen.queryByText(/is already the club time zone/)).toBeNull();
    expect(saveButton().hasAttribute("disabled")).toBe(false);

    fireEvent.click(saveButton());
    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(JSON.parse(String(putCalls()[0][1].body))).toEqual({
      timeZone: "Pacific/Auckland",
      confirmed: true,
    });
  });

  it("always offers the configured zone, even when the filter excludes it", async () => {
    // ICU disagrees with itself across versions about canonical spellings, so a
    // stored zone can be missing from this runtime's list — and a filter can hide
    // it. Either way the <select> must still carry an option for its own value,
    // or it displays a zone the club is not on.
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.change(screen.getByLabelText("Find a time zone"), {
      target: { value: "reykjavik" },
    });

    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toContain("Pacific/Auckland");
    expect(options).toContain("Atlantic/Reykjavik");
    expect(
      (screen.getByLabelText("Time zone") as HTMLSelectElement).value,
    ).toBe("Pacific/Auckland");
  });

  it("keeps Save disabled when the chosen zone is the one already stored", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.click(screen.getByRole("checkbox"));

    expect(saveButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText(/is already the club time zone/)).not.toBeNull();
  });

  it("shows the current and chosen zone side by side, and what changing does", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "Pacific/Chatham" },
    });

    expect(screen.getByTestId("confirm-current-zone").textContent).toBe(
      "Pacific/Auckland",
    );
    expect(screen.getByTestId("confirm-chosen-zone").textContent).toBe(
      "Pacific/Chatham",
    );

    // The three consequences the acknowledgement is about, in plain English.
    expect(
      screen.getByText(/already recorded are not rewritten or moved/),
    ).not.toBeNull();
    expect(
      screen.getByText(/how times are shown from now on/),
    ).not.toBeNull();
    expect(
      screen.getByText(/keep the calendar dates they already have/),
    ).not.toBeNull();
    // And the acknowledgement itself says what it is acknowledging.
    expect(
      screen.getByText(
        /does not move any date or time already recorded/,
      ),
    ).not.toBeNull();
  });

  it("sends the chosen zone with an explicit confirmation, and shows the result", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "Pacific/Chatham" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(saveButton());

    await waitFor(() => expect(putCalls()).toHaveLength(1));
    expect(JSON.parse(String(putCalls()[0][1].body))).toEqual({
      timeZone: "Pacific/Chatham",
      confirmed: true,
    });
    await waitFor(() =>
      expect(screen.getByTestId("current-club-time-zone").textContent).toBe(
        "Pacific/Chatham",
      ),
    );
    // Back to read-only, with the acknowledgement cleared for next time.
    expect(screen.queryByRole("checkbox")).toBeNull();
  });

  it("shows the server's refusal rather than pretending the change landed", async () => {
    fetchMock.mockImplementation(async (_url: unknown, init?: { method?: string }) =>
      init?.method === "PUT"
        ? {
            ok: false,
            json: async () => ({ error: "Nope, not a real timezone." }),
          }
        : respondWith(SERVER_STATE),
    );
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "Pacific/Chatham" },
    });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(saveButton());

    await screen.findByText("Nope, not a real timezone.");
    expect(screen.getByTestId("current-club-time-zone").textContent).toBe(
      "Pacific/Auckland",
    );
  });

  it("filters the selector without narrowing what can be saved", async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Change time zone/ }));

    const before = screen.getAllByRole("option").length;
    expect(before).toBeGreaterThan(300);

    fireEvent.change(screen.getByLabelText("Find a time zone"), {
      target: { value: "auckland" },
    });

    const after = screen.getAllByRole("option").map((o) => o.textContent);
    expect(after).toContain("Pacific/Auckland");
    expect(after.length).toBeLessThan(before);
  });
});
