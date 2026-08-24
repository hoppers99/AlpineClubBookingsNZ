"use client";

import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Loader2,
  RotateCcw,
  SkipForward,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { ADMIN_PERMISSION_AREAS } from "@/lib/admin-permissions";
import type { SetupWizardStepDetail } from "@/lib/setup-wizard-view";
import { setupWizardStepLabel } from "./setup-wizard-rail";

/**
 * The step frame (epic #213, child C5) — the right-hand pane.
 *
 * It COMPOSES the readiness check that already exists for this step: its title,
 * its message, its detail lines and its "open the real editor" link. It builds
 * no editor of its own, and must not: the deep steps arrive with C6 (lodges) and
 * C7 (styling), and the whole point of D8's parity rule is that a wizard step
 * composes the existing editor rather than growing a second one.
 *
 * The three transition controls are the EXISTING progress API
 * (`PATCH /api/admin/setup/progress`), unchanged — the same actions the
 * readiness cards drive. "Skip for now" is D4's deferral, which under D2 buys
 * passage past the step and leaves it visibly outstanding; the frame says so in
 * as many words, because a control called "skip" that does not hide anything
 * needs to explain itself once.
 *
 * D12's view-only pattern: ONE `AdminViewOnlySectionBanner` heads the controls
 * and every gated control is a `ViewOnlyActionButton` with
 * `describeReason={false}`, which is the canonical shape (the banner is in this
 * same file, so no vouch is involved). Back and Continue are NOT gated — moving
 * around the journey is not an edit, and a view-only officer reviewing another
 * area's steps must still be able to walk it.
 */

export type SetupWizardProgressAction = "complete" | "skip" | "reopen";

function areaLabel(area: SetupWizardStepDetail["permissionArea"]): string {
  return (
    ADMIN_PERMISSION_AREAS.find((entry) => entry.key === area)?.label ?? area
  );
}

function stateBadgeVariant(step: SetupWizardStepDetail) {
  if (step.state === "complete") return "success" as const;
  if (step.state === "stale" || step.state === "deferred") return "warning" as const;
  if (step.state === "current") return "outline" as const;
  return "secondary" as const;
}

export function SetupWizardStepFrame({
  step,
  canEdit,
  saving,
  previousStep,
  nextStep,
  launchUnlocked,
  onNavigate,
  onOpenLaunch,
  onProgress,
}: {
  step: SetupWizardStepDetail;
  canEdit: boolean;
  saving: boolean;
  previousStep: SetupWizardStepDetail | null;
  nextStep: SetupWizardStepDetail | null;
  launchUnlocked: boolean;
  onNavigate: (stepId: SetupWizardStepDetail["id"]) => void;
  onOpenLaunch: () => void;
  onProgress: (action: SetupWizardProgressAction) => void;
}) {
  // D2 at the control: Continue is dead unless the next step is reachable. At
  // the END of the list there is no next step, and Continue instead opens the
  // launch panel — but only once the traversal says everything is resolved, so
  // a club with a blocking step cannot walk off the end into it.
  const continueTarget = nextStep
    ? nextStep.isReachable
      ? () => onNavigate(nextStep.id)
      : null
    : launchUnlocked
      ? onOpenLaunch
      : null;

  return (
    <section
      className="rounded-md border bg-card"
      data-testid="setup-wizard-step-frame"
      data-step-id={step.id}
    >
      <div className="space-y-4 p-5">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {step.categoryTitle}
            </p>
            <h2 className="text-2xl font-semibold text-foreground">{step.title}</h2>
            {step.description ? (
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
                {step.description}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={stateBadgeVariant(step)} className="w-fit">
              {setupWizardStepLabel(step)}
            </Badge>
            {step.required ? <Badge variant="outline">Required</Badge> : null}
          </div>
        </div>

        {step.isStale ? (
          <p className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
            This step was finished before, but something it depends on has
            changed since — give it another look.
          </p>
        ) : null}
        {step.isDeferred ? (
          <p className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
            You skipped this for now. It stays on the list as outstanding until
            it is done or no longer applies.
          </p>
        ) : null}

        {step.message ? (
          <p className="text-sm text-muted-foreground">{step.message}</p>
        ) : null}
        {step.details.length > 0 ? (
          <ul className="space-y-1 text-sm text-muted-foreground">
            {step.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        ) : null}

        {step.href ? (
          <Button asChild variant="outline" size="sm">
            <a href={step.href}>
              <ExternalLink className="h-4 w-4" />
              Open the settings for this step
            </a>
          </Button>
        ) : null}
      </div>

      {/* Mounted OUTSIDE the stack above so the empty live-region wrapper adds
          no gap for an edit-capable admin. */}
      <div className="px-5">
        <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-3">
          {areaLabel(step.permissionArea)} edit access is required to change this
          step&apos;s progress. You can still read it and move through the
          wizard.
        </AdminViewOnlySectionBanner>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t px-5 py-4">
        {step.progress !== "completed" ? (
          <ViewOnlyActionButton
            type="button"
            variant="outline"
            size="sm"
            canEdit={canEdit}
            describeReason={false}
            disabled={saving}
            onClick={() => onProgress("complete")}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            Mark this step done
          </ViewOnlyActionButton>
        ) : null}
        {step.progress !== "skipped" ? (
          <ViewOnlyActionButton
            type="button"
            variant="outline"
            size="sm"
            canEdit={canEdit}
            describeReason={false}
            disabled={saving}
            onClick={() => onProgress("skip")}
          >
            <SkipForward className="h-4 w-4" />
            Skip for now
          </ViewOnlyActionButton>
        ) : null}
        {step.progress !== "open" ? (
          <ViewOnlyActionButton
            type="button"
            variant="ghost"
            size="sm"
            canEdit={canEdit}
            describeReason={false}
            disabled={saving}
            onClick={() => onProgress("reopen")}
          >
            <RotateCcw className="h-4 w-4" />
            Reopen
          </ViewOnlyActionButton>
        ) : null}

        <div className="ml-auto flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="setup-wizard-back"
            disabled={!previousStep}
            onClick={() => previousStep && onNavigate(previousStep.id)}
          >
            <ArrowLeft className="h-4 w-4" />
            Back
          </Button>
          <Button
            type="button"
            size="sm"
            data-testid="setup-wizard-continue"
            disabled={!continueTarget}
            title={
              continueTarget
                ? undefined
                : "Finish or skip this step before moving on."
            }
            onClick={() => continueTarget?.()}
          >
            Continue
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </section>
  );
}
