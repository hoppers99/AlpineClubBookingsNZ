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
    links: [],
    href: "/admin/booking-policies",
    required: true,
    progress: "open",
    status: "blocked",
    state: "current",
    isReachable: true,
    isStale: false,
    isDeferred: false,
    isDefaulted: false,
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
  const onProviderTest = vi.fn();
  render(
    <SetupWizardStepFrame
      step={detail()}
      canEdit
      saving={false}
      previousStep={null}
      nextStep={null}
      launchUnlocked={false}
      providerTesting={false}
      providerResult={null}
      onNavigate={onNavigate}
      onOpenLaunch={onOpenLaunch}
      onProgress={onProgress}
      onProviderTest={onProviderTest}
      {...overrides}
    />,
  );
  return { onProgress, onNavigate, onOpenLaunch, onProviderTest };
}

/** A step whose readiness check declares a provider test — Stripe's. */
function providerStep(overrides: Partial<SetupWizardStepDetail> = {}) {
  return detail({
    id: "stripe" as SetupStepId,
    title: "Stripe",
    href: "/admin/stripe/setup",
    permissionArea: "finance",
    action: { type: "provider-test", provider: "stripe", label: "Test Stripe" },
    ...overrides,
  });
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

  // D12. An officer who cannot change progress gets NO reachable transition:
  // every button is disabled and one banner states why. Mutation-verified:
  // dropping `canEdit` from the ViewOnlyActionButtons fails this test.
  it("gives an officer who cannot change progress no edit affordance", () => {
    const { onProgress } = renderFrame({ canEdit: false });
    const banner = screen.getByTestId("admin-view-only-banner");
    expect(banner.textContent).toContain(ADMIN_VIEW_ONLY_SECTION_HEADING);
    // The banner names the axis the SERVER enforces (support), not the step's
    // own settings area — this step's is Bookings & Beds.
    expect(banner.textContent).toContain("Support edit access is required");
    expect(banner.textContent).not.toContain("Bookings & Beds");

    for (const name of [/Mark this step done/, /Skip for now/]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(onProgress).not.toHaveBeenCalled();
  });

  // The step's own area is still ON the screen — it is what decides whether the
  // settings link's destination is any use — but as context for that link
  // rather than as the gate on the buttons.
  it("names the step's own area against the settings link, not against the buttons", () => {
    renderFrame();
    expect(
      screen.getByTestId("setup-wizard-step-settings-area").textContent,
    ).toContain("Bookings & Beds");
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

  /*
    Per-lodge destinations (C6, #221). The lodges step needs a list whose length
    is the club's own — one link per lodge — which the single `href` cannot
    express, so the frame renders `links` as well. Every other step supplies an
    empty array and gets nothing, which is the part worth pinning: a new field
    on a shared view model must not put a stray empty list on the other
    nineteen steps, none of which asked for one.
  */
  it("renders one link per entry in `links`, beside the settings link", () => {
    renderFrame({
      step: detail({
        id: "lodges" as SetupStepId,
        title: "Lodges",
        href: "/admin/lodges",
        links: [
          { label: "Review Example Lodge's setup", href: "/admin/lodges/a/setup" },
          { label: "Finish setting up River Lodge", href: "/admin/lodges/b/setup" },
        ],
      }),
    });
    const list = screen.getByTestId("setup-wizard-step-links");
    const anchors = list.querySelectorAll("a");
    expect([...anchors].map((a) => a.getAttribute("href"))).toEqual([
      "/admin/lodges/a/setup",
      "/admin/lodges/b/setup",
    ]);
    expect(list.textContent).toContain("Finish setting up River Lodge");
    // The step's own settings link is still there and is still the single
    // "open the settings for this step" affordance.
    expect(screen.getByText("Open the settings for this step")).toBeTruthy();
  });

  it("renders nothing at all for a step with no links", () => {
    renderFrame();
    expect(screen.queryByTestId("setup-wizard-step-links")).toBeNull();
  });

  /*
    The provider test (C8, #223). Until the fix round this control existed only
    on the readiness cards, which the legacy-surfaces switch hides — so hiding
    them deleted a capability rather than relocating it. These five assertions
    are the parity claim at the render level: the button is here for the steps
    that declare one, absent for those that do not, fires the provider the check
    named, and is gated on the same answer the server gives.
  */
  it("offers the provider test for a step whose check declares one", () => {
    const { onProviderTest } = renderFrame({ step: providerStep() });
    const button = screen.getByTestId("setup-wizard-provider-test");
    expect(button.textContent).toContain("Test Stripe");
    fireEvent.click(button);
    expect(onProviderTest).toHaveBeenCalledWith("stripe");
  });

  it("offers no provider test for a step whose check declares none", () => {
    renderFrame();
    expect(screen.queryByTestId("setup-wizard-provider-test")).toBeNull();
    expect(screen.queryByTestId("setup-wizard-provider-test-result")).toBeNull();
  });

  it("shows the provider's own answer, tinted by whether it worked", () => {
    renderFrame({
      step: providerStep(),
      providerResult: { ok: false, message: "Stripe key rejected." },
    });
    const panel = screen.getByTestId("setup-wizard-provider-test-result");
    expect(panel.textContent).toContain("Stripe key rejected.");
    expect(panel.className).toContain("danger");

    cleanup();
    renderFrame({
      step: providerStep(),
      providerResult: { ok: true, message: "Stripe reachable." },
    });
    expect(
      screen.getByTestId("setup-wizard-provider-test-result").className,
    ).toContain("success");
  });

  it("disables the provider test while one is in flight", () => {
    const { onProviderTest } = renderFrame({
      step: providerStep(),
      providerTesting: true,
    });
    const button = screen.getByTestId(
      "setup-wizard-provider-test",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onProviderTest).not.toHaveBeenCalled();
  });

  // The POST infers `support: edit` from its path and method, which is the same
  // question `canEdit` answers for the three progress controls — so a view-only
  // officer must not be handed a button whose request 403s.
  it("gates the provider test on the same answer the server gives", () => {
    const { onProviderTest } = renderFrame({
      step: providerStep(),
      canEdit: false,
    });
    const button = screen.getByTestId(
      "setup-wizard-provider-test",
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onProviderTest).not.toHaveBeenCalled();
    // One banner already explains all of it; this control adds no second copy.
    expect(screen.getAllByTestId("admin-view-only-banner")).toHaveLength(1);
  });

  it("says plainly what a skipped step and a stale step mean", () => {
    renderFrame({ step: detail({ isDeferred: true, state: "deferred" }) });
    expect(screen.getByText(/stays on the list as outstanding/)).toBeTruthy();
    cleanup();
    renderFrame({ step: detail({ isStale: true, state: "stale" }) });
    expect(screen.getByText(/give it another look/)).toBeTruthy();
  });

  /*
    D14/D15 (#237). The defaulted notice is the frame's whole job on this state:
    the rail can only carry three words, and what an operator needs here is that
    a value IS set, that nobody chose it, and what to do about it. D15 makes the
    state stop the journey, so the notice has to name BOTH ways past it — an
    operator blocked by a default they cannot decide today would otherwise be
    left with no stated way forward.
  */
  it("says a default is in place, and names both ways past it", () => {
    renderFrame({ step: detail({ isDefaulted: true, state: "defaulted" }) });
    const notice = screen.getByTestId("setup-wizard-step-defaulted");
    expect(notice.textContent).toMatch(/nothing has confirmed it/i);
    expect(notice.textContent).toMatch(/mark this step done/i);
    expect(notice.textContent).toMatch(/skip it for now/i);
  });

  it("reads the defaulted notice off the FLAG, not off the state", () => {
    // The state machine's precedence is lossy — `current` hides `defaulted` —
    // and the resume point on a fresh install is exactly that combination. A
    // notice branched on `state === "defaulted"` would therefore be invisible on
    // the one step every operator meets first.
    renderFrame({ step: detail({ state: "current" }) });
    expect(screen.queryByTestId("setup-wizard-step-defaulted")).toBeNull();
    cleanup();
    renderFrame({ step: detail({ isDefaulted: true, state: "current" }) });
    expect(screen.queryByTestId("setup-wizard-step-defaulted")).not.toBeNull();
  });
});
