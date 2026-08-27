// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupStepId } from "@/lib/setup-step-registry";
import type { SetupWizardRailGroup, SetupWizardRailStep } from "@/lib/setup-wizard-view";
import {
  SETUP_WIZARD_LAUNCH_ID,
  SetupWizardRail,
  setupWizardRailFadeVisible,
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
    isDefaulted: false,
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
      step("defaulted-here", { state: "defaulted", isDefaulted: true }),
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
    for (const id of [
      "done",
      "here",
      "skipped",
      "looked",
      "defaulted-here",
      "untouched",
      "locked",
    ]) {
      expect(screen.getByTestId(`setup-wizard-rail-row-${id}`)).toBeTruthy();
    }
  });

  it("renders the six states distinguishably", () => {
    renderRail();
    const stateOf = (id: string) =>
      screen.getByTestId(`setup-wizard-rail-row-${id}`).getAttribute("data-state");
    expect(stateOf("done")).toBe("complete");
    expect(stateOf("here")).toBe("current");
    expect(stateOf("skipped")).toBe("deferred");
    expect(stateOf("looked")).toBe("stale");
    // D14 (#237): a default is in place and nobody confirmed it. Its own state,
    // not a reuse of not-started — the two are different situations, and the
    // rail is what tells an operator which one they are looking at.
    expect(stateOf("defaulted-here")).toBe("defaulted");
    expect(stateOf("untouched")).toBe("not-started");

    // …and says so in words as well as in colour, because colour alone is not a
    // state an operator can read out.
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Up next")).toBeTruthy();
    expect(screen.getByText("Needs another look")).toBeTruthy();
    expect(screen.getByText("Skipped for now")).toBeTruthy();
    expect(screen.getByText("Default in place")).toBeTruthy();
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

  // The one combination D14 (#237) adds, and the one an operator meets first:
  // the resume point on a fresh install is current AND defaulted. `current`
  // wins the state precedence, so without the accumulated label the row would
  // read like an ordinary next step and the fact that something is already set
  // — possibly wrongly — would never reach the rail at all.
  it("still says a current step is sitting on a default", () => {
    cleanup();
    render(
      <SetupWizardRail
        groups={[
          {
            id: "foundation",
            title: "Foundation",
            description: "",
            steps: [
              step("defaulted-here", { state: "current", isDefaulted: true }),
            ],
          },
        ]}
        percentComplete={0}
        currentStepId={"defaulted-here" as SetupStepId}
        selectedId={"defaulted-here" as SetupStepId}
        launchUnlocked={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("Up next — a default is in place")).toBeTruthy();
  });

  // The three combinations the single-branch label dropped a fact from. Each is
  // a state the traversal really produces: a step you skip stays CURRENT
  // (deferring completes nothing), and a step recorded complete then re-opened
  // by an upstream change is STALE while still sitting in `skippedStepIds`.
  // Mutation-verified: returning on the first matching flag fails all three.
  it("keeps every fact when a step is stale AND deferred", () => {
    cleanup();
    render(
      <SetupWizardRail
        groups={[
          {
            id: "foundation",
            title: "Foundation",
            description: "",
            steps: [
              // Current + stale + deferred: the position and BOTH flags.
              step("all-three", {
                state: "current",
                isStale: true,
                isDeferred: true,
              }),
              // Not current, stale + deferred: the state says "stale", and the
              // deferral used to vanish entirely. This is the one that matters
              // most — it still caps the frontier (#219 F2) while reading, in
              // the old wording, like a step already dealt with.
              step("stale-and-skipped", {
                state: "stale",
                isStale: true,
                isDeferred: true,
              }),
              // Not current, deferred only: unchanged, and pinned so the
              // accumulation cannot start double-naming it.
              step("just-skipped", { state: "deferred", isDeferred: true }),
            ],
          },
        ]}
        percentComplete={0}
        currentStepId={"all-three" as SetupStepId}
        selectedId={"all-three" as SetupStepId}
        launchUnlocked={false}
        onSelect={vi.fn()}
      />,
    );
    expect(
      screen.getByText("Up next — needs another look, skipped for now"),
    ).toBeTruthy();
    expect(screen.getByText("Needs another look — skipped for now")).toBeTruthy();
    expect(screen.getByText("Skipped for now")).toBeTruthy();
  });

  // Colour-blind parity: a current step that is ALSO stale is work to be redone
  // and caps the frontier, so the warning must not live only in the row's text.
  // Mutation-verified: drawing straight off `step.state` fails this.
  it("draws a current step that is stale as stale, not as an ordinary next step", () => {
    cleanup();
    render(
      <SetupWizardRail
        groups={[
          {
            id: "foundation",
            title: "Foundation",
            description: "",
            steps: [
              step("stale-here", { state: "current", isStale: true }),
              step("plain-here", { state: "current" }),
              // Deferral deliberately does NOT take the surface: it is the
              // operator's own choice and it does not cap the frontier.
              step("skipped-here", { state: "current", isDeferred: true }),
              // Nor does `defaulted`, even though it DOES cap the frontier —
              // this is the row the wizard is sending the operator to next, so
              // they cannot walk past the warning the way they could past a
              // stale row further down (D14, #237).
              step("defaulted-here", { state: "current", isDefaulted: true }),
            ],
          },
        ]}
        percentComplete={0}
        currentStepId={"stale-here" as SetupStepId}
        selectedId={null}
        launchUnlocked={false}
        onSelect={vi.fn()}
      />,
    );
    const visual = (id: string) =>
      screen
        .getByTestId(`setup-wizard-rail-row-${id}`)
        .getAttribute("data-visual-state");
    expect(visual("stale-here")).toBe("stale");
    expect(visual("plain-here")).toBe("current");
    expect(visual("skipped-here")).toBe("current");
    expect(visual("defaulted-here")).toBe("current");
    // The underlying state is untouched — the rail draws it differently, it
    // does not relabel the state machine.
    expect(
      screen.getByTestId("setup-wizard-rail-row-stale-here").getAttribute("data-state"),
    ).toBe("current");
    // …and the amber surface really is on the row, not merely announced.
    expect(
      screen.getByTestId("setup-wizard-rail-row-stale-here").className,
    ).toContain("border-warning-6");
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

  // The scroll mechanics. jsdom lays nothing out — every element reports a zero
  // height — so what a component test CAN pin is the structure and the rule,
  // and the visual half is verified in a browser. Both halves were wrong: the
  // "sticky" header sat OUTSIDE the scrolling element, where `sticky` positions
  // against the page rather than the list; and the fade was rendered
  // unconditionally, permanently dimming the last row, which is the launch CTA.
  describe("scroll mechanics", () => {
    it("puts the sticky summary INSIDE the element that scrolls", () => {
      renderRail();
      const scroller = screen.getByTestId("setup-wizard-rail-scroller");
      expect(scroller.className).toContain("overflow-y-auto");
      const header = screen
        .getByTestId("setup-wizard-percent")
        .closest("div.sticky");
      expect(header).toBeTruthy();
      // Contained by the scroller, which is what makes `sticky` stick to the
      // list's scroll instead of the page's.
      expect(scroller.contains(header!)).toBe(true);
    });

    it("paints no fade when the list is not overflowing", () => {
      // jsdom's zero heights ARE the non-overflowing case, honestly measured.
      renderRail();
      expect(screen.queryByTestId("setup-wizard-rail-fade")).toBeNull();
    });

    it("decides the fade from overflow AND distance from the bottom", () => {
      // Short list, nothing to signal.
      expect(
        setupWizardRailFadeVisible({
          scrollTop: 0,
          scrollHeight: 200,
          clientHeight: 400,
        }),
      ).toBe(false);
      // Exactly filling its box is not overflow either.
      expect(
        setupWizardRailFadeVisible({
          scrollTop: 0,
          scrollHeight: 400,
          clientHeight: 400,
        }),
      ).toBe(false);
      // Long list, more below: signal it.
      expect(
        setupWizardRailFadeVisible({
          scrollTop: 0,
          scrollHeight: 900,
          clientHeight: 400,
        }),
      ).toBe(true);
      // Scrolled to the end — the launch CTA is the last row, and dimming it
      // there is the defect this rule exists to prevent.
      expect(
        setupWizardRailFadeVisible({
          scrollTop: 500,
          scrollHeight: 900,
          clientHeight: 400,
        }),
      ).toBe(false);
      // Sub-pixel scroll positions still count as the bottom.
      expect(
        setupWizardRailFadeVisible({
          scrollTop: 499.6,
          scrollHeight: 900,
          clientHeight: 400,
        }),
      ).toBe(false);
    });

    it("re-measures on scroll", () => {
      renderRail();
      const scroller = screen.getByTestId("setup-wizard-rail-scroller");
      // Give the scroller a geometry jsdom would never produce, then scroll:
      // the handler re-reads it and the fade appears.
      for (const [key, value] of [
        ["scrollHeight", 900],
        ["clientHeight", 400],
        ["scrollTop", 0],
      ] as const) {
        Object.defineProperty(scroller, key, { configurable: true, value });
      }
      fireEvent.scroll(scroller);
      expect(screen.getByTestId("setup-wizard-rail-fade")).toBeTruthy();

      Object.defineProperty(scroller, "scrollTop", {
        configurable: true,
        value: 500,
      });
      fireEvent.scroll(scroller);
      expect(screen.queryByTestId("setup-wizard-rail-fade")).toBeNull();
    });
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
