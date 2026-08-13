// @vitest-environment jsdom

/**
 * CHOOSING WHAT AN INVESTIGATION IS ABOUT (AID-7, #2378, owner decision D11).
 *
 * Four of these are the reason the file exists rather than a screenshot, because
 * each one is a rule that a plausible refactor would quietly break:
 *
 *  - the control does not exist for an admin the widget did not grant Diagnostics;
 *  - choosing a row sends that row's id — one id, not the last row's, which is what
 *    a mount-time registration would have produced;
 *  - choosing the SAME row twice reopens the panel (the nonce);
 *  - a chosen record does not follow the operator to another screen.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DiagnosticsRecordButton } from "@/components/help-widget/diagnostics-record-button";
import { HelpWidget } from "@/components/help-widget/help-widget";
import { HelpWidgetProvider } from "@/components/help-widget/help-widget-context";
import type { HelpPageContent } from "@/lib/help/types";

const mocks = vi.hoisted(() => ({ pathname: "/admin/bookings" }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));

const CONTENT: HelpPageContent = {
  title: "Bookings",
  summary: "",
  actions: [],
  sections: [],
  questions: [],
};

/** A stand-in for the bookings list: three rows, each offering its own record. */
function Rows() {
  return (
    <>
      {["bk-one", "bk-two", "bk-three"].map((id) => (
        <DiagnosticsRecordButton key={id} recordId={id} subject={id} />
      ))}
    </>
  );
}

function renderAdmin(
  props: { diagnostics?: { moduleEnabled: boolean } } = {
    diagnostics: { moduleEnabled: true },
  },
) {
  return render(
    <HelpWidgetProvider>
      <Rows />
      <HelpWidget
        surface="admin"
        llmEnabled={false}
        resolveHelp={() => CONTENT}
        {...props}
      />
    </HelpWidgetProvider>,
  );
}

function buttonFor(subject: string) {
  return screen.getByRole("button", {
    name: `Ask diagnostics about ${subject}`,
  });
}

beforeEach(() => {
  mocks.pathname = "/admin/bookings";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        status: "blocked",
        reason: "no_answer",
        message: "The assistant did not return an answer.",
      }),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the control exists only where Diagnostics does (#2378 D11)", () => {
  it("renders nothing when the admin was not granted Diagnostics", async () => {
    renderAdmin({});
    // The widget publishes availability in an effect, so give it the chance to
    // publish TRUE before concluding that it did not.
    await waitFor(() =>
      expect(screen.getByTestId("help-widget-launcher")).toBeTruthy(),
    );
    expect(screen.queryAllByTestId("diagnostics-record-button")).toHaveLength(0);
  });

  it("renders nothing when the module is off", async () => {
    renderAdmin({ diagnostics: { moduleEnabled: false } });
    await waitFor(() =>
      expect(screen.getByTestId("help-widget-launcher")).toBeTruthy(),
    );
    expect(screen.queryAllByTestId("diagnostics-record-button")).toHaveLength(0);
  });

  it("appears once per row when both halves are granted", async () => {
    renderAdmin();
    await waitFor(() =>
      expect(screen.getAllByTestId("diagnostics-record-button")).toHaveLength(3),
    );
  });
});

describe("choosing a row (#2378 D11)", () => {
  it("opens the panel on Diagnostics and sends THAT row's id", async () => {
    renderAdmin();
    await waitFor(() =>
      expect(screen.getAllByTestId("diagnostics-record-button")).toHaveLength(3),
    );

    // The middle row, deliberately: a mount-time registration would have made the
    // LAST row the subject, and picking the last one would not have caught it.
    fireEvent.click(buttonFor("bk-two"));

    const input = await screen.findByTestId("diagnostics-input");
    fireEvent.change(input, { target: { value: "why is this stuck?" } });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      (fetch as unknown as { mock: { calls: [string, { body: string }][] } }).mock
        .calls[0][1].body,
    );
    expect(body.recordId).toBe("bk-two");
    expect(body.pathname).toBe("/admin/bookings");
  });

  it("reopens the panel when the same row is chosen again", async () => {
    renderAdmin();
    await waitFor(() =>
      expect(screen.getAllByTestId("diagnostics-record-button")).toHaveLength(3),
    );

    fireEvent.click(buttonFor("bk-one"));
    expect(await screen.findByTestId("diagnostics-input")).toBeTruthy();

    // Close it, then choose the SAME row. An id-keyed effect would not re-run,
    // and the operator would click a button that appears to do nothing.
    fireEvent.click(screen.getByTestId("help-widget-launcher"));
    await waitFor(() =>
      expect(screen.queryByTestId("diagnostics-input")).toBeNull(),
    );

    fireEvent.click(buttonFor("bk-one"));
    expect(await screen.findByTestId("diagnostics-input")).toBeTruthy();
  });
});

describe("the record does not follow the operator (#2378 D11)", () => {
  it("is dropped on navigation, while the conversation stays", async () => {
    const { rerender } = renderAdmin();
    await waitFor(() =>
      expect(screen.getAllByTestId("diagnostics-record-button")).toHaveLength(3),
    );
    fireEvent.click(buttonFor("bk-one"));
    expect(await screen.findByTestId("diagnostics-input")).toBeTruthy();

    // A booking id carried onto the payments list could only ever ask about a
    // payment that does not exist — the server derives the KIND from the route.
    mocks.pathname = "/admin/payments";
    rerender(
      <HelpWidgetProvider>
        <Rows />
        <HelpWidget
          surface="admin"
          llmEnabled={false}
          resolveHelp={() => CONTENT}
          diagnostics={{ moduleEnabled: true }}
        />
      </HelpWidgetProvider>,
    );

    const input = await screen.findByTestId("diagnostics-input");
    fireEvent.change(input, { target: { value: "why is this stuck?" } });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      (fetch as unknown as { mock: { calls: [string, { body: string }][] } }).mock
        .calls[0][1].body,
    );
    expect(body.recordId).toBeUndefined();
    expect(body.pathname).toBe("/admin/payments");
  });
});
