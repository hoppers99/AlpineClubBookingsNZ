// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action";
import type { SetupStepId } from "@/lib/setup-step-registry";
import type { SetupWizardEnvironmentRow } from "@/lib/setup-wizard-view";
import { SetupWizardEnvironmentPanel } from "@/app/(admin)/admin/setup/wizard/setup-wizard-environment-panel";

/**
 * The Server-environment panel (epic #213, **D17**, child C15 #246).
 *
 * These are the panel's own behaviours, over hand-built rows. What the rows
 * CONTAIN — which facts exist, which remedy each carries, which hold publish
 * shut — is `setup-wizard-view.test.ts`'s, over the real registry and the real
 * readiness builder; asserting it here as well would pin the fixture rather
 * than the product.
 *
 * The three claims worth the file:
 *
 * 1. a green fact still renders, so "all fine" is distinguishable from "not
 *    checked";
 * 2. an amber fact reads as somebody else's job, in R2-3's order;
 * 3. the two provider tests survived the move off the rail.
 */

afterEach(() => {
  cleanup();
});

function row(
  overrides: Partial<SetupWizardEnvironmentRow> = {},
): SetupWizardEnvironmentRow {
  return {
    id: "runtime-env" as SetupStepId,
    title: "Runtime Environment",
    description: "Database, auth, app origin, cron, and seed-admin contract.",
    status: "complete",
    blocksLaunch: false,
    message: "Required runtime variables are present and well formed.",
    details: [],
    remedy: null,
    permissionArea: "support",
    ...overrides,
  };
}

const amberRemedy = {
  who: "Whoever runs your server fixes this.",
  send: "CRON_SECRET is missing from this deployment's .env — set it and restart.",
  why: "Nothing that happens overnight happens.",
};

function renderPanel(
  overrides: Partial<Parameters<typeof SetupWizardEnvironmentPanel>[0]> = {},
) {
  const onProviderTest = vi.fn();
  render(
    <SetupWizardEnvironmentPanel
      rows={[row()]}
      canEdit
      providerRunning={null}
      providerResults={{}}
      onProviderTest={onProviderTest}
      {...overrides}
    />,
  );
  return { onProviderTest };
}

describe("SetupWizardEnvironmentPanel (D17, #246)", () => {
  it("says plainly that these are not the operator's steps", () => {
    renderPanel();
    expect(screen.getByTestId("setup-wizard-environment-panel")).toBeTruthy();
    // The sentence R2-3 asked for, at the top of the screen: an operator must
    // not read this panel as a list of things they have failed to do.
    expect(
      screen.getByText(/facts about the server this site runs on, not steps/i),
    ).toBeTruthy();
  });

  it("RENDERS A GREEN ROW — 'all fine' must be distinguishable from 'not checked'", () => {
    renderPanel();
    const rendered = screen.getByTestId("setup-wizard-environment-row-runtime-env");
    expect(rendered.getAttribute("data-status")).toBe("complete");
    expect(
      screen.getByText("Required runtime variables are present and well formed."),
    ).toBeTruthy();
    // …and offers no remedy, because there is nothing to remedy. A panel that
    // tells a working deployment to go and fix itself trains its reader to stop
    // reading it.
    expect(
      screen.queryByTestId("setup-wizard-environment-remedy-runtime-env"),
    ).toBeNull();
  });

  it("leads an amber row with WHO, then the line to send, then why", () => {
    renderPanel({
      rows: [row({ status: "blocked", remedy: amberRemedy })],
    });
    const remedy = screen.getByTestId(
      "setup-wizard-environment-remedy-runtime-env",
    );
    const text = remedy.textContent ?? "";
    // Order is the finding, not decoration: R2-3's complaint was that the
    // wizard named a fault without naming whose it was.
    expect(text.indexOf(amberRemedy.who)).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(amberRemedy.who)).toBeLessThan(
      text.indexOf(amberRemedy.send),
    );
    expect(text.indexOf(amberRemedy.send)).toBeLessThan(
      text.indexOf(amberRemedy.why),
    );
    // The why is collapsed — an operator forwarding a line to their deployer
    // does not need it.
    expect(remedy.querySelector("details")).toBeTruthy();
  });

  it("marks a row that holds the site shut, and summarises the set", () => {
    renderPanel({
      rows: [
        row({ status: "blocked", blocksLaunch: true, remedy: amberRemedy }),
        row({ id: "sentry" as SetupStepId, title: "Sentry", status: "warning" }),
      ],
    });
    expect(
      screen
        .getByTestId("setup-wizard-environment-row-runtime-env")
        .getAttribute("data-blocks-launch"),
    ).toBe("true");
    expect(
      screen
        .getByTestId("setup-wizard-environment-row-sentry")
        .getAttribute("data-blocks-launch"),
    ).toBe("false");

    const summary = screen.getByTestId(
      "setup-wizard-environment-blocking-summary",
    );
    expect(summary.textContent).toContain("Runtime Environment");
    expect(summary.textContent).not.toContain("Sentry");
    // AMBER DOES NOT BLOCK WALKING — the distinction the whole design turns on,
    // said on the screen rather than only in the code.
    expect(summary.textContent).toMatch(
      /carry on setting the club up in the meantime/i,
    );
  });

  it("shows no blocking summary when nothing is blocking", () => {
    renderPanel({
      rows: [row({ status: "warning", remedy: amberRemedy })],
    });
    expect(
      screen.queryByTestId("setup-wizard-environment-blocking-summary"),
    ).toBeNull();
  });

  it("KEEPS THE PROVIDER TEST, and runs it", () => {
    // The control that would have been deleted rather than relocated. See
    // `SetupWizardEnvironmentRow.action`'s docblock and #223.
    const { onProviderTest } = renderPanel({
      rows: [
        row({
          id: "email-ses" as SetupStepId,
          title: "Email Delivery",
          status: "warning",
          remedy: amberRemedy,
          action: { type: "provider-test", provider: "smtp", label: "Test Email" },
        }),
      ],
    });
    const button = screen.getByTestId(
      "setup-wizard-environment-provider-test-email-ses",
    );
    expect(button.textContent).toContain("Test Email");
    fireEvent.click(button);
    expect(onProviderTest).toHaveBeenCalledWith("smtp");
  });

  it("shows a provider test's answer against the row that asked", () => {
    renderPanel({
      rows: [
        row({
          id: "email-ses" as SetupStepId,
          status: "warning",
          remedy: amberRemedy,
          action: { type: "provider-test", provider: "smtp", label: "Test Email" },
        }),
      ],
      providerResults: { smtp: { ok: false, message: "SMTP refused the connection" } },
    });
    expect(
      screen.getByTestId("setup-wizard-environment-provider-result-email-ses")
        .textContent,
    ).toContain("SMTP refused the connection");
  });

  it("disables the test while it is running, and only that row's", () => {
    renderPanel({
      rows: [
        row({
          id: "email-ses" as SetupStepId,
          status: "warning",
          action: { type: "provider-test", provider: "smtp", label: "Test Email" },
        }),
        row({
          id: "sentry" as SetupStepId,
          status: "warning",
          action: { type: "provider-test", provider: "sentry", label: "Test Sentry" },
        }),
      ],
      providerRunning: "smtp",
    });
    expect(
      screen
        .getByTestId("setup-wizard-environment-provider-test-email-ses")
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      screen
        .getByTestId("setup-wizard-environment-provider-test-sentry")
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("gates the test behind edit access, and still shows every fact", () => {
    renderPanel({
      canEdit: false,
      rows: [
        row({
          id: "email-ses" as SetupStepId,
          status: "warning",
          remedy: amberRemedy,
          action: { type: "provider-test", provider: "smtp", label: "Test Email" },
        }),
      ],
    });
    // The banner appends a full stop to the heading constant, so this matches
    // on the constant rather than asserting an exact string that includes it.
    expect(
      screen.getByText(new RegExp(ADMIN_VIEW_ONLY_SECTION_HEADING, "i")),
    ).toBeTruthy();
    // Reading is not gated: a view-only officer still needs to be able to see
    // what is wrong with the deployment and who to tell.
    expect(
      screen.getByTestId("setup-wizard-environment-remedy-email-ses"),
    ).toBeTruthy();
  });

  it("offers no progress control of any kind", () => {
    // The point of the split, asserted as an ABSENCE. Nothing on this panel may
    // let somebody mark a deployment fact done — the progress route refuses it
    // with 422, and a control that produced that error would be a worse screen
    // than no control at all.
    renderPanel({ rows: [row({ status: "blocked", remedy: amberRemedy })] });
    for (const label of [/mark this step done/i, /skip for now/i, /reopen/i]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("says so when a deployment has nothing to report", () => {
    renderPanel({ rows: [] });
    expect(
      screen.getByText(/nothing to report about this deployment/i),
    ).toBeTruthy();
  });
});
