"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  CircleDashed,
  CircleDot,
  CircleHelp,
  Lock,
  RefreshCw,
  Rocket,
  SkipForward,
} from "lucide-react";
import type { SetupStepId } from "@/lib/setup-step-registry";
import type { SetupWizardStepState } from "@/lib/setup-wizard-traversal";
import type { SetupWizardRailGroup, SetupWizardRailStep } from "@/lib/setup-wizard-view";
import { cn } from "@/lib/utils";

/**
 * The step rail (epic #213, child C5) — the whole journey, one row per
 * applicable step, grouped under the readiness categories.
 *
 * Four things this component is responsible for, each an acceptance criterion:
 *
 * - **the summary stays put while the list scrolls.** The percentage and its bar
 *   are a `sticky top-0` header INSIDE the scrolling element itself, which is
 *   what makes `sticky` do anything: a sticky box positions against its nearest
 *   SCROLLING ancestor, so the same markup one level up — where this header used
 *   to sit — sticks against the page's scroll and never against the list's. The
 *   rail scrolls under its own summary; the page does not have to move.
 * - **the list signals overflow, and only when there IS overflow.** A
 *   non-interactive gradient sits over the last few pixels of the scroll region
 *   while the list is longer than its box AND not scrolled to the bottom, so a
 *   long list never ends on a hard edge that reads as the end of the journey —
 *   and a short one, or a list read to its end, is not permanently dimmed across
 *   its last row. That row is the launch CTA, so an unconditional fade greyed
 *   out the one control the whole journey leads to.
 * - **the current step is scrolled into view on open.** Once, on the first
 *   render that has a current step — not on every re-render, or a refetch would
 *   yank an operator back from the row they were reading.
 * - **an unreachable row is not a link.** D2's frontier is enforced at the
 *   CONTROL, not by a redirect afterwards: an unreachable step renders as a
 *   `div` with no click handler and no keyboard affordance, so there is nothing
 *   to navigate with. `onSelect` is never called for one.
 *
 * The percentage is a PROP, taken from the traversal (D7). Nothing here counts
 * rows.
 */

/** The sentinel the launch panel occupies at the end of the rail (D9). */
export const SETUP_WIZARD_LAUNCH_ID = "__launch__";

export type SetupWizardRailSelection = SetupStepId | typeof SETUP_WIZARD_LAUNCH_ID;

function StateIcon({ state }: { state: SetupWizardStepState }) {
  switch (state) {
    case "complete":
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-success-11" />;
    case "current":
      return <CircleDot className="h-4 w-4 shrink-0 text-brand-gold" />;
    case "stale":
      return <RefreshCw className="h-4 w-4 shrink-0 text-warning-11" />;
    case "deferred":
      return <SkipForward className="h-4 w-4 shrink-0 text-warning-11" />;
    // D14 (#237): a default is in place and nobody has confirmed it. Its own
    // glyph rather than a reuse of the not-started dashed circle, because the
    // two are genuinely different situations for an operator — one has nothing
    // in it, the other has something in it that may well be wrong.
    case "defaulted":
      return <CircleHelp className="h-4 w-4 shrink-0 text-warning-11" />;
    case "not-started":
      return <CircleDashed className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
}

/**
 * The words an operator reads, per state.
 *
 * "Needs another look" rather than "stale": D3 describes the state as "I
 * completed this, then something upstream changed and it needs another look",
 * and that sentence is the one an operator can act on. "Stale" is the codebase's
 * word for it and stays in the code.
 *
 * "Default in place" rather than "defaulted", for the same reason, and in the
 * register the club-time-zone check already reached for when it hand-rolled this
 * distinction ("the club's timezone is Pacific/Auckland, but nothing has
 * confirmed it"). It states what is true — there IS a value, and it may be
 * perfectly right — without claiming anybody has agreed to it (D14, #237).
 */
export const SETUP_WIZARD_STATE_LABEL: Record<SetupWizardStepState, string> = {
  complete: "Done",
  current: "Up next",
  stale: "Needs another look",
  deferred: "Skipped for now",
  defaulted: "Default in place",
  "not-started": "Not started",
};

/**
 * The label a step carries in the rail and in the step frame's badge — which is
 * NOT always its own state's label.
 *
 * The state machine's precedence is LOSSY on purpose, and this puts back what it
 * dropped. `current` wins over `stale` and `deferred`, and `stale` wins over
 * `deferred` (`SetupWizardStepState` says so, and the two flags are carried on
 * the step precisely so a reader can recover what the precedence hid). A step can
 * genuinely be all three: `currentStepId` is the first step that is not COMPLETE
 * and deferring completes nothing, so the step you just skipped stays current;
 * and a step recorded complete but re-opened by an upstream change is stale while
 * still sitting in `skippedStepIds` from an earlier pass.
 *
 * So the label is built by ACCUMULATION rather than by picking one branch —
 * position first, then stale, then deferred — and every combination keeps every
 * fact:
 *
 * | state | stale | deferred | reads |
 * | --- | --- | --- | --- |
 * | current | — | — | Up next |
 * | current | yes | — | Up next — needs another look |
 * | current | — | yes | Up next — skipped for now |
 * | current | yes | yes | Up next — needs another look, skipped for now |
 * | stale | yes | — | Needs another look |
 * | stale | yes | yes | Needs another look — skipped for now |
 *
 * The two `current`+one-flag rows were already right; the other two dropped a
 * fact each. The stale-and-deferred pair matters most, because it is exactly the
 * step that still CAPS THE FRONTIER (#219 F2) while looking, in the old wording,
 * like an ordinary skipped step the operator had already dealt with.
 *
 * `isDefaulted` (D14, #237) joins the accumulation on the same footing and adds
 * exactly ONE row — `current` + defaulted, reading "Up next — a default is in
 * place". It cannot combine with the other two: `defaulted` requires that the
 * operator has neither confirmed the step (which is what `stale` is intersected
 * against) nor skipped it (which is what `deferred` is). So the resume point on
 * a fresh install is the only place the qualifier shows.
 *
 * It also says "up next" rather than "you are here": the row the operator is
 * LOOKING at is the selected one, marked separately by `aria-current="step"` and
 * the highlight, and the two are different rows the moment somebody walks past a
 * step they deferred.
 */
export function setupWizardStepLabel(step: SetupWizardRailStep): string {
  const position = SETUP_WIZARD_STATE_LABEL[step.state];
  if (step.state === "complete" || step.state === "not-started") return position;

  const qualifiers: string[] = [];
  // `state` already carries one of these when it is not `current`; only the
  // facts the state did NOT say need appending.
  if (step.isStale && step.state !== "stale") qualifiers.push("needs another look");
  if (step.isDeferred && step.state !== "deferred") qualifiers.push("skipped for now");
  if (step.isDefaulted && step.state !== "defaulted")
    qualifiers.push("a default is in place");
  if (qualifiers.length === 0) return position;
  return `${position} — ${qualifiers.join(", ")}`;
}

/**
 * The state a row is DRAWN as, which is not always the state it is IN.
 *
 * `current` is a neutral, unalarming look — a gold ring saying "you are heading
 * here next". A step that is current AND stale is not unalarming: it is work
 * that has to be redone, and it caps the frontier. Drawing it as an ordinary
 * current row leaves that warning living only in the row's text, which is
 * exactly the failure colour-blind and low-vision operators are left with when a
 * status is carried by one channel. So staleness takes the surface, and the
 * label above still carries the position.
 *
 * Deferral deliberately does NOT do this. It is the operator's own choice, made
 * seconds earlier by pressing the button, and it does not cap the frontier — so
 * the amber it earns is the amber of an ordinary `deferred` row, and where it
 * coincides with `current` the position is the more useful thing to show.
 *
 * NEITHER DOES `defaulted` (D14, #237), even though it DOES cap the frontier —
 * so the frontier is not what the rule turns on. Staleness takes the surface
 * because it is a warning about work already done that has quietly stopped being
 * true, and an operator can walk past a merely-textual warning on a row they
 * were not heading for. A defaulted step that is also current is the row the
 * wizard is sending them to next: they cannot walk past it, the step frame states
 * the default in full on arrival, and repainting the resume point amber on a
 * fresh install would tint most of the rail on the one journey where nothing has
 * gone wrong yet. The label still carries both facts.
 */
function railVisualState(step: SetupWizardRailStep): SetupWizardStepState {
  return step.state === "current" && step.isStale ? "stale" : step.state;
}

function stateClasses(state: SetupWizardStepState, selected: boolean): string {
  // A SOLID fill. `app-theme-layout-contract.test.ts` bans an interpolated
  // brand or semantic BACKGROUND on any app text surface — Tailwind's
  // transparent composite crosses back toward the foreground and fails AA on
  // the endpoint palettes a club can legitimately save — so the gold BORDER
  // carries the selection and `bg-muted` is the designed surface under it.
  // (That contract scans this file as TEXT, so do not spell a banned class here
  // even in a comment: the regex has no idea it is reading prose.)
  if (selected) return "border-brand-gold bg-muted text-foreground";
  switch (state) {
    case "complete":
      return "border-transparent text-foreground hover:border-border";
    case "current":
      return "border-brand-gold/60 text-foreground";
    // `defaulted` shares the amber of the other two outstanding-but-populated
    // states: something IS set here and it wants a person's eye on it. The icon
    // and the label are what tell the three apart, and `data-visual-state`
    // publishes the answer so a test never has to read a class name.
    case "stale":
    case "deferred":
    case "defaulted":
      return "border-warning-6 bg-warning-3 text-warning-11";
    case "not-started":
      return "border-transparent text-muted-foreground hover:border-border";
  }
}

function RailRow({
  step,
  selected,
  onSelect,
  rowRef,
}: {
  step: SetupWizardRailStep;
  selected: boolean;
  onSelect: (id: SetupStepId) => void;
  rowRef?: (node: HTMLElement | null) => void;
}) {
  const label = setupWizardStepLabel(step);
  const visualState = railVisualState(step);
  const body = (
    <>
      <StateIcon state={visualState} />
      <span className="min-w-0 flex-1 truncate text-sm">{step.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
    </>
  );
  const shared = "flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left";

  // Unreachable: no button, no handler, no tab stop. D2's rule is the control's
  // absence rather than a guard somewhere downstream of a click.
  if (!step.isReachable) {
    return (
      <div
        ref={rowRef}
        data-testid={`setup-wizard-rail-row-${step.id}`}
        data-state={step.state}
        data-reachable="false"
        aria-disabled="true"
        title="Finish the steps before this one first."
        className={cn(shared, "cursor-not-allowed border-transparent opacity-50")}
      >
        <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm">{step.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      </div>
    );
  }

  return (
    <button
      ref={rowRef as (node: HTMLButtonElement | null) => void}
      type="button"
      data-testid={`setup-wizard-rail-row-${step.id}`}
      data-state={step.state}
      // The state it is DRAWN as — equal to `data-state` except where staleness
      // takes the surface off `current`. Published so the colour-parity rule can
      // be asserted without a test reading Tailwind class names.
      data-visual-state={visualState}
      data-reachable="true"
      aria-current={selected ? "step" : undefined}
      onClick={() => onSelect(step.id)}
      className={cn(shared, "transition-colors", stateClasses(visualState, selected))}
    >
      {body}
    </button>
  );
}

/**
 * Should the bottom fade be painted, given the scroller's geometry?
 *
 * Pure and exported because it is the whole of the decision, and jsdom gives
 * every element a zero height — so a component test can pin the rule exactly
 * while the layout it reads can only be checked in a real browser. The one-pixel
 * tolerances absorb sub-pixel scroll positions, which otherwise leave a
 * scrolled-to-the-bottom list showing a fade forever.
 */
export function setupWizardRailFadeVisible(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  const overflowing = metrics.scrollHeight > metrics.clientHeight + 1;
  const atBottom =
    metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 1;
  return overflowing && !atBottom;
}

export function SetupWizardRail({
  groups,
  percentComplete,
  currentStepId,
  selectedId,
  launchUnlocked,
  onSelect,
}: {
  groups: readonly SetupWizardRailGroup[];
  percentComplete: number;
  currentStepId: SetupStepId | null;
  selectedId: SetupWizardRailSelection | null;
  launchUnlocked: boolean;
  onSelect: (id: SetupWizardRailSelection) => void;
}) {
  const currentRowRef = useRef<HTMLElement | null>(null);
  const scrolledRef = useRef(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [fadeVisible, setFadeVisible] = useState(false);

  useEffect(() => {
    if (scrolledRef.current) return;
    const node = currentRowRef.current;
    if (!node) return;
    scrolledRef.current = true;
    // `scrollIntoView` is not implemented in jsdom, so the component tests
    // assert the ref is attached to the current row rather than the scroll.
    node.scrollIntoView?.({ block: "center" });
  }, [currentStepId, groups]);

  const measureFade = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    setFadeVisible(setupWizardRailFadeVisible(node));
  }, []);

  // Three things change the answer: the list itself (a module toggled off), the
  // box (a window resize, or the viewport-relative max-height changing under
  // it), and the scroll position. The first two are handled here; the third is
  // the scroller's own onScroll.
  useEffect(() => {
    measureFade();
    const node = scrollerRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureFade);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measureFade, groups, launchUnlocked]);

  return (
    <div className="rounded-md border bg-card" data-testid="setup-wizard-rail">
      <div className="relative">
        <div
          ref={scrollerRef}
          onScroll={measureFade}
          data-testid="setup-wizard-rail-scroller"
          className="max-h-[60vh] overflow-y-auto lg:max-h-[calc(100vh-16rem)]"
        >
          {/* INSIDE the scroller, or `sticky` sticks to the page instead. */}
          <div className="sticky top-0 z-10 space-y-2 rounded-t-md border-b bg-card px-4 py-3">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-sm font-medium text-foreground">Setup progress</p>
              <p
                className="text-2xl font-semibold text-foreground"
                data-testid="setup-wizard-percent"
              >
                {percentComplete}%
              </p>
            </div>
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuenow={percentComplete}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Setup progress"
            >
              <div
                className="h-full rounded-full bg-brand-gold transition-all"
                style={{ width: `${percentComplete}%` }}
              />
            </div>
          </div>

          <div className="space-y-4 px-2 py-3">
            {groups.map((group) => (
              <div key={group.id} className="space-y-1">
                <p className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {group.title}
                </p>
                {group.steps.map((step) => (
                  <RailRow
                    key={step.id}
                    step={step}
                    selected={selectedId === step.id}
                    onSelect={onSelect}
                    rowRef={
                      step.id === currentStepId
                        ? (node) => {
                            currentRowRef.current = node;
                          }
                        : undefined
                    }
                  />
                ))}
              </div>
            ))}

            <div className="space-y-1">
              <p className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Finish
              </p>
              {launchUnlocked ? (
                <button
                  type="button"
                  data-testid="setup-wizard-rail-row-launch"
                  data-reachable="true"
                  aria-current={
                    selectedId === SETUP_WIZARD_LAUNCH_ID ? "step" : undefined
                  }
                  onClick={() => onSelect(SETUP_WIZARD_LAUNCH_ID)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left transition-colors",
                    selectedId === SETUP_WIZARD_LAUNCH_ID
                      ? "border-brand-gold bg-muted text-foreground"
                      : "border-transparent text-foreground hover:border-border",
                  )}
                >
                  <Rocket className="h-4 w-4 shrink-0 text-success-11" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    Ready to open
                  </span>
                </button>
              ) : (
                <div
                  data-testid="setup-wizard-rail-row-launch"
                  data-reachable="false"
                  aria-disabled="true"
                  title="Finish or skip every remaining step to unlock this."
                  className="flex w-full cursor-not-allowed items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left opacity-50"
                >
                  <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    Ready to open
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Overflow signal, painted only while there is overflow left to signal.
            `pointer-events-none` so it never eats a click on the row underneath
            it — and, unconditional, it permanently dimmed that row, which at the
            foot of this list is the launch CTA. */}
        {fadeVisible ? (
          <div
            data-testid="setup-wizard-rail-fade"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-md bg-gradient-to-t from-card to-transparent"
          />
        ) : null}
      </div>
    </div>
  );
}
