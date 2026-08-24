// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupStepId } from "@/lib/setup-step-registry";
import type { SetupWizardRailGroup, SetupWizardRailStep } from "@/lib/setup-wizard-view";
import {
  SETUP_WIZARD_LAUNCH_ID,
  SetupWizardRail,
} from "@/app/(admin)/admin/setup/wizard/setup-wizard-rail";

/**
 * The rail's state rendering (epic #213, C5) — the acceptance criteria that say
 * the rail shows every applicable step WITH ITS STATE, keeps its summary while
 * the list scrolls, and does not let an operator jump ahead.
 */

afterEach(cleanup);

function step(
  id: string,
  overrides: Partial<SetupWizardRailStep> = {},
): SetupWizardRailStep {
  return {
    id: id as SetupStepId,
    title: `Step ${id}`,
    state: "not-started",
    isReachable: true,
    isStale: false,
    isDeferred: false,
    permissionArea: "support",
    ...overrides,
  };
}

const groups: SetupWizardRailGroup[] = [
  {
    id: "foundation",
    title: "Foundation",
    description: "Club identity and first-install readiness.",
    steps: [
      step("done", { state: "complete" }),
      step("here", { state: "current" }),
      step("skipped", { state: "deferred", isDeferred: true }),
    ],
  },
  {
    id: "booking",
    title: "Booking Rules",
    description: "Capacity, rates, seasons.",
    steps: [
      step("looked", { state: "stale", isStale: true }),
      step("untouched", { state: "not-started" }),
      step("locked", { state: "not-started", isReachable: false }),
    ],
  },
];

function renderRail(overrides: Partial<Parameters<typeof SetupWizardRail>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <SetupWizardRail
      groups={groups}
      percentComplete={42}
      currentStepId={"here" as SetupStepId}
      selectedId={"here" as SetupStepId}
      launchUnlocked={false}
      onSelect={onSelect}
      {...overrides}
    />,
  );
  return { onSelect };
}

describe("SetupWizardRail", () => {
  it("renders every applicable step under its category heading", () => {
    renderRail();
    expect(screen.getByText("Foundation")).toBeTruthy();
    expect(screen.getByText("Booking Rules")).toBeTruthy();
    for (const id of ["done", "here", "skipped", "looked", "untouched", "locked"]) {
      expect(screen.getByTestId(`setup-wizard-rail-row-${id}`)).toBeTruthy();
    }
  });

  it("renders the five states distinguishably", () => {
    renderRail();
    const stateOf = (id: string) =>
      screen.getByTestId(`setup-wizard-rail-row-${id}`).getAttribute("data-state");
    expect(stateOf("done")).toBe("complete");
    expect(stateOf("here")).toBe("current");
    expect(stateOf("skipped")).toBe("deferred");
    expect(stateOf("looked")).toBe("stale");
    expect(stateOf("untouched")).toBe("not-started");

    // …and says so in words as well as in colour, because colour alone is not a
    // state an operator can read out.
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Up next")).toBeTruthy();
    expect(screen.getByText("Needs another look")).toBeTruthy();
    expect(screen.getByText("Skipped for now")).toBeTruthy();
  });

  // The traversal's `current` wins over `deferred` and `stale`, and
  // `currentStepId` is the first step that is not COMPLETE — so the step you
  // just deferred STAYS current. Without the compound label the rail would go
  // on reading like an ordinary next step and the deferral would vanish from
  // it. Mutation-verified: labelling rows straight off
  // SETUP_WIZARD_STATE_LABEL fails this test.
  it("still says a current step was deferred, or has gone stale", () => {
    cleanup();
    render(
      <SetupWizardRail
        groups={[
          {
            id: "foundation",
            title: "Foundation",
            description: "",
            steps: [
              step("skipped-here", { state: "current", isDeferred: true }),
              step("stale-here", { state: "current", isStale: true }),
            ],
          },
        ]}
        percentComplete={0}
        currentStepId={"skipped-here" as SetupStepId}
        selectedId={"skipped-here" as SetupStepId}
        launchUnlocked={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Up next — skipped for now")).toBeTruthy();
    expect(screen.getByText("Up next — needs another look")).toBeTruthy();
  });

  it("shows the traversal's percentage and nothing it computed itself", () => {
    renderRail();
    expect(screen.getByTestId("setup-wizard-percent").textContent).toBe("42%");
    const bar = screen.getByRole("progressbar", { name: "Setup progress" });
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
  });

  it("navigates on a reachable row", () => {
    const { onSelect } = renderRail();
    fireEvent.click(screen.getByTestId("setup-wizard-rail-row-done"));
    expect(onSelect).toHaveBeenCalledWith("done");
  });

  // D2 AT THE CONTROL. An unreachable row is not a button at all, so there is
  // nothing to click and nothing to tab to — the rule is not a guard that runs
  // after a click. Mutation-verified: making RailRow render every row as a
  // button fails this test.
  it("gives an unreachable row no way to navigate", () => {
    const { onSelect } = renderRail();
    const locked = screen.getByTestId("setup-wizard-rail-row-locked");
    expect(locked.tagName).toBe("DIV");
    expect(locked.getAttribute("data-reachable")).toBe("false");
    expect(locked.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(locked);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("scrolls the current step into view once, on open", () => {
    const scrollIntoView = vi.fn();
    // jsdom implements no scrolling, so the element's own method is the seam.
    Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
      writable: true,
    });
    renderRail();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
  });

  it("locks the launch row until the traversal says everything is resolved (D9)", () => {
    const { onSelect } = renderRail();
    const locked = screen.getByTestId("setup-wizard-rail-row-launch");
    expect(locked.getAttribute("data-reachable")).toBe("false");
    fireEvent.click(locked);
    expect(onSelect).not.toHaveBeenCalled();

    cleanup();
    const unlocked = renderRail({ launchUnlocked: true });
    const row = screen.getByTestId("setup-wizard-rail-row-launch");
    expect(row.getAttribute("data-reachable")).toBe("true");
    fireEvent.click(row);
    expect(unlocked.onSelect).toHaveBeenCalledWith(SETUP_WIZARD_LAUNCH_ID);
  });
});
