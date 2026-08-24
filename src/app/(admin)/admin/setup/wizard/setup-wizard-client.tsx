"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { SetupReadiness } from "@/lib/setup-readiness";
import type { SetupStepId } from "@/lib/setup-step-registry";
import type { SetupWizardTraversal } from "@/lib/setup-wizard-traversal";
import {
  buildSetupWizardView,
  canEditSetupStep,
  resolveInitialStepId,
  setupWizardNeighbours,
} from "@/lib/setup-wizard-view";
import {
  SETUP_WIZARD_LAUNCH_ID,
  SetupWizardRail,
  type SetupWizardRailSelection,
} from "./setup-wizard-rail";
import { SetupWizardLaunchPanel } from "./setup-wizard-launch-panel";
import {
  SetupWizardStepFrame,
  type SetupWizardProgressAction,
} from "./setup-wizard-step-frame";

/**
 * The wizard shell (epic #213, child C5) — the first VISIBLE piece of the epic.
 *
 * It owns three things and delegates the rest:
 *
 * 1. **One read.** `GET /api/admin/setup/wizard` returns readiness, progress and
 *    C4's traversal together, and `buildSetupWizardView` marries them. Nothing
 *    here derives a percentage, a frontier or a step state — D7's percentage in
 *    particular is copied through untouched.
 * 2. **Where the operator is.** The landing step is the traversal's
 *    `currentStepId`, so leaving and coming back resumes rather than restarts.
 * 3. **Refetching, so the rail follows the module flags (D4/D5).** Switching a
 *    module off must remove its steps from the rail without a page reload, and
 *    the modules editor is a DIFFERENT admin page — this child links out to it
 *    rather than embedding its toggles (a toggle in the rail is C3's). So the
 *    honest mechanism is a refetch when the operator comes back to this tab or
 *    window, which is exactly when the flags can have changed. It is not a
 *    subscription and does not claim to be: a flag changed in another tab shows
 *    up here the moment this tab is focused, and the Refresh button forces it.
 */

interface SetupWizardPayload {
  readiness: SetupReadiness;
  traversal: SetupWizardTraversal<SetupStepId>;
}

function errorMessageFrom(body: unknown, fallback: string) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

export function SetupWizardClient({
  permissionMatrix,
}: {
  permissionMatrix: AdminPermissionMatrix;
}) {
  const [payload, setPayload] = useState<SetupWizardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [selectedId, setSelectedId] = useState<SetupWizardRailSelection | null>(
    null,
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/setup/wizard", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as SetupWizardPayload | { error?: string };
      if (!response.ok || !("traversal" in body)) {
        throw new Error(errorMessageFrom(body, "Failed to load the setup wizard"));
      }
      setPayload(body);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load the setup wizard",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // D4/D5: the modules editor is another page, so a module flag changes while
  // this tab is in the background. Coming back to it is the moment to re-read.
  useEffect(() => {
    function refresh() {
      if (document.visibilityState === "visible") void load();
    }
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  const view = useMemo(
    () =>
      payload
        ? buildSetupWizardView(payload.readiness, payload.traversal)
        : null,
    [payload],
  );

  // The selection has to survive a refetch, but not survive a step DISAPPEARING
  // — which is precisely what happens when the module owning it is switched off
  // (D4). Resolving it on every render, against the freshly-loaded view, is what
  // makes "the rail updates without a page reload" true for the frame as well as
  // for the rail.
  const activeStepId = useMemo(() => {
    if (!view) return null;
    if (selectedId === SETUP_WIZARD_LAUNCH_ID) {
      return view.allResolved ? SETUP_WIZARD_LAUNCH_ID : view.currentStepId;
    }
    return resolveInitialStepId(view, selectedId);
  }, [view, selectedId]);

  const activeStep =
    view && activeStepId && activeStepId !== SETUP_WIZARD_LAUNCH_ID
      ? (view.steps.find((step) => step.id === activeStepId) ?? null)
      : null;

  const neighbours = useMemo(
    () =>
      view && activeStep
        ? setupWizardNeighbours(view, activeStep.id)
        : { previous: null, next: null },
    [view, activeStep],
  );

  async function updateProgress(
    action: SetupWizardProgressAction,
    stepId: SetupStepId,
  ) {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/setup/progress", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, stepId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          errorMessageFrom(body, "Failed to update setup progress"),
        );
      }
      await load();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to update setup progress",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading && !view) {
    return (
      <div className="flex min-h-[320px] items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading the setup wizard
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="setup-wizard">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-3xl font-bold text-foreground">Setup wizard</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Work through the club&apos;s setup one step at a time. It remembers
            where you got to, so you can leave it and come back.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <Link href="/admin/setup">
              <ArrowLeft className="h-4 w-4" />
              Setup checklist
            </Link>
          </Button>
          <Button variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:items-start">
          <SetupWizardRail
            groups={view.groups}
            percentComplete={view.percentComplete}
            currentStepId={view.currentStepId}
            selectedId={activeStepId}
            launchUnlocked={view.allResolved}
            onSelect={setSelectedId}
          />

          {activeStepId === SETUP_WIZARD_LAUNCH_ID ? (
            <SetupWizardLaunchPanel
              view={view}
              permissionMatrix={permissionMatrix}
            />
          ) : activeStep ? (
            <SetupWizardStepFrame
              step={activeStep}
              canEdit={canEditSetupStep(permissionMatrix, activeStep)}
              saving={saving}
              previousStep={neighbours.previous}
              nextStep={neighbours.next}
              launchUnlocked={view.allResolved}
              onNavigate={setSelectedId}
              onOpenLaunch={() => setSelectedId(SETUP_WIZARD_LAUNCH_ID)}
              onProgress={(action) => void updateProgress(action, activeStep.id)}
            />
          ) : (
            <section className="rounded-md border bg-card p-5 text-sm text-muted-foreground">
              There is nothing to set up: every module that contributes a setup
              step is switched off.
            </section>
          )}
        </div>
      ) : null}
    </div>
  );
}
