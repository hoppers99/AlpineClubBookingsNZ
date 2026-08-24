"use client";

import { useEffect, useRef } from "react";
import {
  CheckCircle2,
  CircleDashed,
  CircleDot,
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
 *   are a `sticky top-0` header INSIDE the scroll container's parent, and the
 *   list below is its own `overflow-y-auto` region. The rail scrolls; the page
 *   does not have to.
 * - **the list signals overflow.** A non-interactive gradient sits over the last
 *   few pixels of the scroll region, so a list longer than its box never ends on
 *   a hard edge that reads as the end of the journey.
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
 */
export const SETUP_WIZARD_STATE_LABEL: Record<SetupWizardStepState, string> = {
  complete: "Done",
  current: "Up next",
  stale: "Needs another look",
  deferred: "Skipped for now",
  "not-started": "Not started",
};

/**
 * The label a step carries in the rail and in the step frame's badge — which is
 * NOT always its own state's label.
 *
 * `current` is the traversal's RESUME POINT, and it wins over `stale` and
 * `deferred` when a step is both (`SetupWizardStepState` says so, and the two
 * flags are carried on the step precisely so a reader can recover what the
 * precedence hid). That is right for the state machine and lossy for a rail:
 * deferring the step you are on leaves it CURRENT, because `currentStepId` is
 * the first step that is not COMPLETE and deferring completes nothing. Without
 * this the row would go on reading like an ordinary next step while the
 * deferral — the whole point of pressing the button — vanished from the rail.
 *
 * It also says "up next" rather than "you are here": the row the operator is
 * LOOKING at is the selected one, marked separately by `aria-current="step"` and
 * the highlight, and the two are different rows the moment somebody walks past a
 * step they deferred.
 */
export function setupWizardStepLabel(step: SetupWizardRailStep): string {
  if (step.state !== "current") return SETUP_WIZARD_STATE_LABEL[step.state];
  if (step.isStale) return "Up next — needs another look";
  if (step.isDeferred) return "Up next — skipped for now";
  return SETUP_WIZARD_STATE_LABEL.current;
}

function stateClasses(state: SetupWizardStepState, selected: boolean): string {
  if (selected) return "border-brand-gold bg-brand-gold/10 text-foreground";
  switch (state) {
    case "complete":
      return "border-transparent text-foreground hover:border-border";
    case "current":
      return "border-brand-gold/60 text-foreground";
    case "stale":
    case "deferred":
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
  const body = (
    <>
      <StateIcon state={step.state} />
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
      data-reachable="true"
      aria-current={selected ? "step" : undefined}
      onClick={() => onSelect(step.id)}
      className={cn(shared, "transition-colors", stateClasses(step.state, selected))}
    >
      {body}
    </button>
  );
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

  useEffect(() => {
    if (scrolledRef.current) return;
    const node = currentRowRef.current;
    if (!node) return;
    scrolledRef.current = true;
    // `scrollIntoView` is not implemented in jsdom, so the component tests
    // assert the ref is attached to the current row rather than the scroll.
    node.scrollIntoView?.({ block: "center" });
  }, [currentStepId, groups]);

  return (
    <div className="rounded-md border bg-card" data-testid="setup-wizard-rail">
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

      <div className="relative">
        <div className="max-h-[60vh] space-y-4 overflow-y-auto px-2 py-3 lg:max-h-[calc(100vh-16rem)]">
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
                aria-current={selectedId === SETUP_WIZARD_LAUNCH_ID ? "step" : undefined}
                onClick={() => onSelect(SETUP_WIZARD_LAUNCH_ID)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md border px-2 py-2 text-left transition-colors",
                  selectedId === SETUP_WIZARD_LAUNCH_ID
                    ? "border-brand-gold bg-brand-gold/10 text-foreground"
                    : "border-transparent text-foreground hover:border-border",
                )}
              >
                <Rocket className="h-4 w-4 shrink-0 text-success-11" />
                <span className="min-w-0 flex-1 truncate text-sm">Ready to open</span>
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
                <span className="min-w-0 flex-1 truncate text-sm">Ready to open</span>
              </div>
            )}
          </div>
        </div>
        {/* Overflow signal. `pointer-events-none` so it never eats a click on
            the row underneath it. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-md bg-gradient-to-t from-card to-transparent" />
      </div>
    </div>
  );
}
