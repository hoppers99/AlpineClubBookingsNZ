// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADMIN_VIEW_ONLY_SECTION_HEADING } from "@/components/admin/view-only-action";
import type { SetupStepId } from "@/lib/setup-step-registry";
import type { SetupWizardStepDetail } from "@/lib/setup-wizard-view";
import { SetupWizardStepFrame } from "@/app/(admin)/admin/setup/wizard/setup-wizard-step-frame";

/**
 * The step frame (epic #213, C5): D12's view-only gating and D2's Continue rule.
 */

afterEach(cleanup);

function detail(overrides: Partial<SetupWizardStepDetail> = {}): SetupWizardStepDetail {
  return {
    id: "booking-policies" as SetupStepId,
    title: "Booking Policy",
    categoryId: "booking",
    categoryTitle: "Booking Rules",
    description: "Holds, lead times and cut-offs.",
    message: "Booking policy defaults are unset.",
    details: ["Hold window: not set"],
    href: "/admin/booking-policies",
    required: true,
    progress: "open",
    status: "blocked",
    state: "current",
    isReachable: true,
    isStale: false,
    isDeferred: false,
    permissionArea: "bookings",
    ...overrides,
  };
}

function renderFrame(
  overrides: Partial<Parameters<typeof SetupWizardStepFrame>[0]> = {},
) {
  const onProgress = vi.fn();
  const onNavigate = vi.fn();
  const onOpenLaunch = vi.fn();
  render(
    <SetupWizardStepFrame
      step={detail()}
      canEdit
      saving={false}
      previousStep={null}
      nextStep={null}
      launchUnlocked={false}
      onNavigate={onNavigate}
      onOpenLaunch={onOpenLaunch}
      onProgress={onProgress}
      {...overrides}
    />,
  );
  return { onProgress, onNavigate, onOpenLaunch };
}

describe("SetupWizardStepFrame", () => {
  it("composes the readiness check rather than building an editor", () => {
    renderFrame();
    expect(screen.getByText("Booking Policy")).toBeTruthy();
    expect(screen.getByText("Booking policy defaults are unset.")).toBeTruthy();
    expect(screen.getByText("Hold window: not set")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Open the settings for this step/ })
        .getAttribute("href"),
    ).toBe("/admin/booking-policies");
  });

  it("drives the existing progress API through its three transitions", () => {
    const { onProgress } = renderFrame({ step: detail({ progress: "skipped" }) });
    fireEvent.click(screen.getByRole("button", { name: /Mark this step done/ }));
    expect(onProgress).toHaveBeenCalledWith("complete");
    fireEvent.click(screen.getByRole("button", { name: /Reopen/ }));
    expect(onProgress).toHaveBeenCalledWith("reopen");
    // Already skipped, so "skip for now" is not offered again.
    expect(screen.queryByRole("button", { name: /Skip for now/ })).toBeNull();
  });

  // D12. An officer outside the step's area gets NO reachable edit affordance:
  // every transition is disabled and one banner states why. Mutation-verified:
  // dropping `canEdit` from the ViewOnlyActionButtons fails this test.
  it("gives an officer outside the area no edit affordance", () => {
    const { onProgress } = renderFrame({ canEdit: false });
    const banner = screen.getByTestId("admin-view-only-banner");
    expect(banner.textContent).toContain(ADMIN_VIEW_ONLY_SECTION_HEADING);
    expect(banner.textContent).toContain("Bookings & Beds edit access is required");

    for (const name of [/Mark this step done/, /Skip for now/]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(onProgress).not.toHaveBeenCalled();
  });

  it("still lets a view-only officer walk the journey", () => {
    const previous = detail({ id: "age-tiers" as SetupStepId, title: "Age Tiers" });
    const { onNavigate } = renderFrame({ canEdit: false, previousStep: previous });
    const back = screen.getByTestId("setup-wizard-back") as HTMLButtonElement;
    expect(back.disabled).toBe(false);
    fireEvent.click(back);
    expect(onNavigate).toHaveBeenCalledWith("age-tiers");
  });

  // D2 at the control: Continue is dead past the frontier. Mutation-verified:
  // removing the `nextStep.isReachable` branch fails this test.
  it("refuses to continue past an unreachable next step", () => {
    const next = detail({
      id: "seasons-rates" as SetupStepId,
      isReachable: false,
      state: "not-started",
    });
    const { onNavigate } = renderFrame({ nextStep: next });
    const button = screen.getByTestId("setup-wizard-continue") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("continues into the launch panel only at the end and only once resolved", () => {
    const locked = renderFrame({ launchUnlocked: false });
    expect(
      (screen.getByTestId("setup-wizard-continue") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(locked.onOpenLaunch).not.toHaveBeenCalled();

    cleanup();
    const open = renderFrame({ launchUnlocked: true });
    fireEvent.click(screen.getByTestId("setup-wizard-continue"));
    expect(open.onOpenLaunch).toHaveBeenCalled();
  });

  it("says plainly what a skipped step and a stale step mean", () => {
    renderFrame({ step: detail({ isDeferred: true, state: "deferred" }) });
    expect(screen.getByText(/stays on the list as outstanding/)).toBeTruthy();
    cleanup();
    renderFrame({ step: detail({ isStale: true, state: "stale" }) });
    expect(screen.getByText(/give it another look/)).toBeTruthy();
  });
});
