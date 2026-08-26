"use client";

import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Loader2,
  PlayCircle,
  RotateCcw,
  SkipForward,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { SetupStepLinks } from "@/components/admin/setup-step-links";
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
 * **TWO DIFFERENT PERMISSION QUESTIONS LIVE ON THIS SCREEN, and they have
 * different answers.** Changing a step's PROGRESS is one API for every step, and
 * the server enforces it at `support: edit` — so `canEdit` is that one answer,
 * and the banner names Support. Doing the step's actual WORK happens on another
 * page, governed by that page's own area, which is why the settings link says
 * which area it belongs to rather than pretending the progress gate covered it.
 * Gating the three buttons on the step's own area was wrong in both directions
 * on shipped role bundles: an enabled button whose PATCH 403s, and a disabled
 * button for a transition the server would have accepted.
 *
 * D12's view-only pattern: ONE `AdminViewOnlySectionBanner` heads the controls
 * and every gated control is a `ViewOnlyActionButton` with
 * `describeReason={false}`, which is the canonical shape (the banner is in this
 * same file, so no vouch is involved). Back and Continue are NOT gated — moving
 * around the journey is not an edit, and a view-only officer reviewing another
 * area's steps must still be able to walk it.
 *
 * ## The provider test (C8, #223)
 *
 * Four steps — Stripe, Email, Sentry, Operational Xero — carry a `provider-test`
 * action on their readiness check. It pings the live service and writes the
 * answer back into the check, and until C8 it rendered ONLY on the readiness
 * cards, which the legacy-surfaces switch hides. A capability with one home,
 * behind a flag that removes that home, is a capability being deleted rather
 * than relocated, which is exactly what D8's parity rule forbids — so the frame
 * composes it here, through the SAME `POST /api/admin/setup/provider-test` the
 * cards call.
 *
 * IT IS GATED ON `canEdit`, and the cards' plain ungated `Button` is NOT the
 * precedent to copy. `POST /api/admin/setup/provider-test` calls a bare
 * `requireAdmin()`, which infers `support: edit` from the path and the method —
 * the same answer `canEdit` already carries for the three progress controls
 * beside it. So an ungated button here would be the first of the two symmetric
 * failures this file's permission note names: an enabled control whose POST
 * 403s. The readiness cards gate none of their controls, which is a looseness
 * of the surface being retired rather than a rule.
 */

export type SetupWizardProgressAction = "complete" | "skip" | "reopen";

/** What a finished provider test said, for the step that asked for it. */
export interface SetupWizardProviderTestResult {
  readonly ok: boolean;
  readonly message: string;
}

function areaLabel(area: SetupWizardStepDetail["permissionArea"]): string {
  return (
    ADMIN_PERMISSION_AREAS.find((entry) => entry.key === area)?.label ?? area
  );
}

function stateBadgeVariant(step: SetupWizardStepDetail) {
  if (step.state === "complete") return "success" as const;
  if (
    step.state === "stale" ||
    step.state === "deferred" ||
    // D14 (#237): outstanding and populated, like the two above it.
    step.state === "defaulted"
  ) {
    return "warning" as const;
  }
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
  providerTesting,
  providerResult,
  onNavigate,
  onOpenLaunch,
  onProgress,
  onProviderTest,
}: {
  step: SetupWizardStepDetail;
  canEdit: boolean;
  saving: boolean;
  previousStep: SetupWizardStepDetail | null;
  nextStep: SetupWizardStepDetail | null;
  launchUnlocked: boolean;
  /** A test for THIS step's provider is in flight. */
  providerTesting: boolean;
  /** The last answer for this step's provider, or null if none yet. */
  providerResult: SetupWizardProviderTestResult | null;
  onNavigate: (stepId: SetupWizardStepDetail["id"]) => void;
  onOpenLaunch: () => void;
  onProgress: (action: SetupWizardProgressAction) => void;
  onProviderTest: (
    provider: NonNullable<SetupWizardStepDetail["action"]>["provider"],
  ) => void;
}) {
  // Read once, so the button and the result panel below cannot disagree about
  // whether this step has a test at all.
  const providerTest = step.action;
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
        {/* D14/D15 (#237). The register is the club-time-zone check's own — say
            what is actually true (there IS a value, it may well be right) and
            ask, rather than assert that anybody agreed to it. It names both
            ways past the step, because D15 makes this state block the journey
            and an operator who cannot decide today needs to be told the way
            round. */}
        {step.isDefaulted ? (
          <p
            data-testid="setup-wizard-step-defaulted"
            className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11"
          >
            A default is in place here and nothing has confirmed it — it was set
            when the site was installed, not chosen for your club. Check it
            below, change it if it is wrong, then mark this step done. If you
            would rather decide later, skip it for now.
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

        {/* Per-lodge destinations (C6, #221): a list whose length is the
            club's own, which the single `href` below cannot express. The
            readiness cards render the same component. */}
        <SetupStepLinks links={step.links} testId="setup-wizard-step-links" />

        {step.href ? (
          <div className="space-y-1">
            <Button asChild variant="outline" size="sm">
              <a href={step.href}>
                <ExternalLink className="h-4 w-4" />
                Open the settings for this step
              </a>
            </Button>
            {/* The step's OWN area, which is a different question from the
                progress gate below and is the one that decides whether this
                link's destination is any use. */}
            <p
              className="text-xs text-muted-foreground"
              data-testid="setup-wizard-step-settings-area"
            >
              That page belongs to {areaLabel(step.permissionArea)}.
            </p>
          </div>
        ) : null}

        {/* The same result idiom the readiness cards use: the provider's own
            sentence, tinted by whether it worked, kept until the next run.
            Branches on the MESSAGE, not just object truthiness — `ok` can be
            true or false with an empty `message`, and that must render
            nothing rather than an empty tinted box. */}
        {providerTest && providerResult?.message ? (
          <div
            data-testid="setup-wizard-provider-test-result"
            className={`rounded-md border px-3 py-2 text-sm ${
              providerResult.ok
                ? "border-success-6 bg-success-3 text-success-11"
                : "border-danger-6 bg-danger-3 text-danger-11"
            }`}
          >
            {providerResult.message}
          </div>
        ) : null}
      </div>

      {/* Mounted OUTSIDE the stack above so the empty live-region wrapper adds
          no gap for an edit-capable admin. */}
      <div className="px-5">
        <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-3">
          Support edit access is required to change any step&apos;s progress —
          that is one setting for the whole journey, not one per step. You can
          still read every step and move through the wizard.
        </AdminViewOnlySectionBanner>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t px-5 py-4">
        {providerTest ? (
          <ViewOnlyActionButton
            type="button"
            variant="outline"
            size="sm"
            canEdit={canEdit}
            describeReason={false}
            data-testid="setup-wizard-provider-test"
            disabled={providerTesting}
            onClick={() => onProviderTest(providerTest.provider)}
          >
            {providerTesting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PlayCircle className="h-4 w-4" />
            )}
            {providerTest.label}
          </ViewOnlyActionButton>
        ) : null}
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
