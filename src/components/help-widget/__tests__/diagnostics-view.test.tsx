// @vitest-environment jsdom

/**
 * THE DIAGNOSTICS TAB (AID-7, #2378; owner decisions D8-D10).
 *
 * Two of these tests are the UI half of a server-side security decision, and they are
 * the reason this file exists rather than a screenshot:
 *
 *  - D9: both consent ticks appear on EVERY question and start unticked. AID-7a grants
 *    both permissions per REQUEST, so a tick that survived a send would be the UI
 *    claiming an authority the gate never gave it.
 *  - D10: the collapsed provenance line always carries the caveat.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HelpWidget } from "@/components/help-widget/help-widget";
import { HelpWidgetProvider } from "@/components/help-widget/help-widget-context";
import type { HelpPageContent } from "@/lib/help/types";
import type { DiagnosticsAskResponse } from "@/lib/diagnostics/answer/contract";

const mocks = vi.hoisted(() => ({ pathname: "/admin/bookings/abc" }));
vi.mock("next/navigation", () => ({ usePathname: () => mocks.pathname }));

const CONTENT: HelpPageContent = {
  title: "Bookings",
  summary: "",
  actions: [],
  sections: [],
  questions: [],
};

function answered(overrides: Partial<DiagnosticsAskResponse> = {}) {
  return {
    status: "answered",
    answer: "The deposit is unpaid.",
    truncated: false,
    provenance: {
      line: "Read from Booking blockers, just now.",
      hasCaveat: false,
      hasPermissionWithheld: false,
      hasConsentWithheld: false,
      hasSearchWithheld: false,
      hasPartialEvidence: false,
      hasStaleEvidence: false,
      withheldAreas: [],
      sources: [
        {
          toolId: "booking_block_state",
          label: "Booking blockers",
          state: "ok",
          stateDescription: "Evidence was retrieved.",
          observedAt: "2026-08-12T11:59:00.000Z",
          rowCount: 3,
          missingAreas: [],
        },
      ],
      roundsUsed: 1,
    },
    ...overrides,
  } as DiagnosticsAskResponse;
}

/**
 * `diagnostics` is spread from an object rather than passed as a defaulted parameter
 * on purpose: an explicit `undefined` argument would trigger a default and the
 * "no prop means no tab" case would silently test the opposite of what it claims.
 * That is exactly what the first version of this file did, and the test failed loudly
 * — which is the only reason it is written this way now.
 */
function renderWidget(
  props: { diagnostics?: { moduleEnabled: boolean } } = {
    diagnostics: { moduleEnabled: true },
  },
) {
  return render(
    <HelpWidgetProvider>
      <HelpWidget
        surface="admin"
        llmEnabled={false}
        resolveHelp={() => CONTENT}
        {...props}
      />
    </HelpWidgetProvider>,
  );
}

function openDiagnostics() {
  fireEvent.click(screen.getByTestId("help-widget-launcher"));
  fireEvent.click(screen.getByTestId("help-widget-tab-diagnostics"));
}

beforeEach(() => {
  mocks.pathname = "/admin/bookings/abc";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => answered(),
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the tab exists only where the server granted it (#2378, Q6)", () => {
  it("is absent when the surface supplied no diagnostics prop", () => {
    renderWidget({});
    fireEvent.click(screen.getByTestId("help-widget-launcher"));
    expect(screen.queryByTestId("help-widget-tab-diagnostics")).toBeNull();
  });

  it("is present when it did", () => {
    renderWidget();
    fireEvent.click(screen.getByTestId("help-widget-launcher"));
    expect(screen.getByTestId("help-widget-tab-diagnostics")).toBeTruthy();
  });

  it("says the module is off rather than offering a box that can only refuse", () => {
    renderWidget({ diagnostics: { moduleEnabled: false } });
    openDiagnostics();
    expect(screen.getByText(/AI Diagnostics is switched off/)).toBeTruthy();
    expect(screen.queryByTestId("diagnostics-input")).toBeNull();
  });
});

describe("the consent ticks are per question (#2378, D9)", () => {
  it("both start unticked", () => {
    renderWidget();
    openDiagnostics();
    expect(
      (screen.getByTestId("diagnostics-consent-search") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (screen.getByTestId("diagnostics-consent-record") as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("sends exactly what was ticked, and RESETS both afterwards", async () => {
    renderWidget();
    openDiagnostics();

    fireEvent.click(screen.getByTestId("diagnostics-consent-search"));
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "who is on this booking?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      (fetch as unknown as { mock: { calls: [string, { body: string }][] } }).mock
        .calls[0][1].body,
    );
    expect(body.allowPeopleSearch).toBe(true);
    expect(body.allowRecordPersonalDetails).toBe(false);
    expect(body.pathname).toBe("/admin/bookings/abc");

    // THE RULE. The server granted people-search for THAT request only, so the box
    // must be empty again before the next one.
    await waitFor(() =>
      expect(
        (screen.getByTestId("diagnostics-consent-search") as HTMLInputElement).checked,
      ).toBe(false),
    );
  });

  it("resets the ticks even when the question was REFUSED", async () => {
    // The worst version of getting this wrong: the operator retries, and a permission
    // they granted for a question that never ran is silently reused for the next one.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          status: "blocked",
          reason: "budget_exhausted",
          message: "Diagnostics has reached this month's spending limit.",
        }),
      }),
    );
    renderWidget();
    openDiagnostics();

    fireEvent.click(screen.getByTestId("diagnostics-consent-search"));
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "who is on this booking?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    await waitFor(() =>
      expect(
        (screen.getByTestId("diagnostics-consent-search") as HTMLInputElement).checked,
      ).toBe(false),
    );
    // And a spent budget disables the input for the rest of the session.
    expect(
      (screen.getByTestId("diagnostics-input") as HTMLTextAreaElement).disabled,
    ).toBe(true);
  });
});

describe("the answer carries its provenance (#2378, D10)", () => {
  it("shows the server's collapsed line, with the detail hidden until asked", async () => {
    renderWidget();
    openDiagnostics();
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "why is this stuck?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    const toggle = await screen.findByTestId("diagnostics-provenance-toggle");
    // The LINE is the server's, verbatim — the client composes no wording of its own.
    expect(toggle.textContent).toContain("Read from Booking blockers, just now.");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Booking blockers")).toBeTruthy();
    expect(screen.getByText(/3 records/)).toBeTruthy();
  });

  it("marks a caveat on the COLLAPSED line, not only inside the expander", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () =>
          answered({
            provenance: {
              ...answered().provenance!,
              line: "Read from Booking blockers, just now — a search was not allowed on this question.",
              hasCaveat: true,
              hasSearchWithheld: true,
            },
          } as Partial<DiagnosticsAskResponse>),
      }),
    );
    renderWidget();
    openDiagnostics();
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "who is on this booking?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    const toggle = await screen.findByTestId("diagnostics-provenance-toggle");
    expect(toggle.getAttribute("data-has-caveat")).toBe("true");
    expect(toggle.textContent).toContain("a search was not allowed");
    // Still collapsed — the caveat reached the operator without them opening anything.
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the conversation stays with the operator (#2378, D8)", () => {
  it("keeps the Diagnostics tab open across a navigation", async () => {
    const { rerender } = renderWidget();
    openDiagnostics();
    expect(screen.getByTestId("diagnostics-input")).toBeTruthy();

    // The operator navigates to the booking they are asking about. Page guide is
    // page-specific and falls back to Ask; an open investigation must not.
    mocks.pathname = "/admin/bookings/def";
    rerender(
      <HelpWidgetProvider>
        <HelpWidget
          surface="admin"
          llmEnabled={false}
          resolveHelp={() => CONTENT}
          diagnostics={{ moduleEnabled: true }}
        />
      </HelpWidgetProvider>,
    );
    expect(screen.getByTestId("diagnostics-input")).toBeTruthy();
  });

  it("shows a pending state while a question is in flight", async () => {
    let resolve: ((value: unknown) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      ),
    );
    renderWidget();
    openDiagnostics();
    fireEvent.change(screen.getByTestId("diagnostics-input"), {
      target: { value: "why is this stuck?" },
    });
    fireEvent.click(screen.getByTestId("diagnostics-send"));

    const pending = await screen.findByTestId("diagnostics-pending");
    // `role="status"` + polite, so it is announced without interrupting.
    expect(pending.getAttribute("role")).toBe("status");
    expect(pending.getAttribute("aria-live")).toBe("polite");

    resolve?.({ ok: true, status: 200, json: async () => answered() });
    await waitFor(() => expect(screen.queryByTestId("diagnostics-pending")).toBeNull());
  });
});
