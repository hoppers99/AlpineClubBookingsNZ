"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { SETUP_READINESS_INPUT_CHANGED_EVENT } from "@/lib/setup-readiness-events";
import type { SetupStepId } from "@/lib/setup-step-registry";
import {
  buildSetupWizardView,
  canChangeSetupProgress,
  resolveInitialStepId,
  setupWizardNeighbours,
  type SetupWizardPayload,
} from "@/lib/setup-wizard-view";
import {
  SETUP_WIZARD_LAUNCH_ID,
  SetupWizardRail,
  type SetupWizardRailSelection,
} from "./setup-wizard-rail";
import { SetupWizardLaunchPanel } from "./setup-wizard-launch-panel";
import { SetupWizardStepPane } from "./setup-wizard-panes";
import {
  SetupWizardStepFrame,
  type SetupWizardProgressAction,
  type SetupWizardProviderTestResult,
} from "./setup-wizard-step-frame";

/**
 * The wizard shell (epic #213, child C5) — the first VISIBLE piece of the epic.
 *
 * It owns three things and delegates the rest:
 *
 * 1. **One read.** `GET /api/admin/setup/wizard` returns readiness, C4's
 *    traversal and whether the public site is live, and `buildSetupWizardView`
 *    marries the first two. Nothing here derives a percentage, a frontier or a
 *    step state — D7's percentage in particular is copied through untouched.
 *    That read is the ONLY one on this screen: the launch panel used to fetch
 *    the club theme for itself, which both froze at mount time and set up a
 *    lost update when it posted the theme back (#220 review F3).
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
 *
 *    **C12 adds the third trigger, and it had to be a new one.** Both events
 *    above are about coming BACK to this tab, and an inline pane
 *    (`setup-wizard-panes.tsx`) is saved without ever leaving it — so neither
 *    fires, and the readiness detail, the state badge and the percentage would
 *    all still be answering the question the operator just watched being
 *    answered. `SETUP_READINESS_INPUT_CHANGED_EVENT` is the panes' announcement
 *    that they persisted something a check reads; the shell treats it as one
 *    more reason to re-read, through the same `load()`.
 *
 * The pane is a SIBLING of the step frame below, never a child of it — the
 * banner-nesting rule and the two genuinely different permissions involved are
 * written out in `setup-wizard-panes.tsx`.
 */

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
  /** The step the operator chose stopped being available, and they were moved. */
  const [moved, setMoved] = useState(false);
  /**
   * A publish is in flight on the launch panel, or has just finished.
   *
   * D9's panel is rendered only while the traversal says `allResolved`, and a
   * refetch can stop saying that at any moment — a step going stale under an
   * upgrade, say. Unmounting the panel mid-publish would DISCARD the result and
   * leave the operator with no idea whether the site went live, so the panel
   * pins itself for the duration and stays pinned afterwards, until they
   * navigate away from it themselves.
   */
  const [launchPinned, setLaunchPinned] = useState(false);
  /**
   * The provider tests (C8, #223), keyed by provider rather than by step so an
   * operator who runs Stripe, walks on and comes back still sees the answer —
   * exactly as the readiness cards behave. Deliberately NOT held in the payload:
   * a test result is a fact about this session, not about the club's stored
   * setup, and the wizard's focus refetch would otherwise wipe it.
   */
  const [providerRunning, setProviderRunning] = useState<string | null>(null);
  const [providerResults, setProviderResults] = useState<
    Record<string, SetupWizardProviderTestResult>
  >({});

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

  // C12: an inline pane saved without the operator leaving the tab, so neither
  // listener above can have fired. Unconditional — unlike the two of them, this
  // event is only dispatched after a write has already succeeded, so there is
  // no visibility test worth making.
  useEffect(() => {
    function reread() {
      void load();
    }
    window.addEventListener(SETUP_READINESS_INPUT_CHANGED_EVENT, reread);
    return () => {
      window.removeEventListener(SETUP_READINESS_INPUT_CHANGED_EVENT, reread);
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
      return view.allResolved || launchPinned
        ? SETUP_WIZARD_LAUNCH_ID
        : view.currentStepId;
    }
    return resolveInitialStepId(view, selectedId);
  }, [view, selectedId, launchPinned]);

  // …and when that fallback FIRES, say so. An operator who chose a step
  // explicitly and then finds the pane showing a different one has, from where
  // they are sitting, watched the screen change under them for no reason — the
  // module owning it was switched off in another tab, or somebody else settled
  // the step and moved the frontier. Landing them somewhere else without a word
  // is the same defect as the Back button's teleport, one refetch later.
  //
  // The selection is cleared at the same moment, deliberately: left set, this
  // would re-fire on every subsequent refetch, and the operator has already been
  // moved once.
  useEffect(() => {
    if (!view || selectedId === null) return;
    const resolved =
      selectedId === SETUP_WIZARD_LAUNCH_ID
        ? view.allResolved || launchPinned
          ? SETUP_WIZARD_LAUNCH_ID
          : view.currentStepId
        : resolveInitialStepId(view, selectedId);
    if (resolved === selectedId) return;
    setSelectedId(null);
    setMoved(true);
  }, [view, selectedId, launchPinned]);

  /** Any deliberate move retires the notice — they can see where they are now. */
  const select = useCallback((id: SetupWizardRailSelection) => {
    setMoved(false);
    // Leaving the launch panel releases its pin: the operator has read whatever
    // the publish had to say and chosen to go elsewhere.
    if (id !== SETUP_WIZARD_LAUNCH_ID) setLaunchPinned(false);
    setSelectedId(id);
  }, []);

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

  /**
   * The SAME endpoint the readiness cards call, with the same shape of answer.
   * A failed request is reported in the result panel rather than in the page's
   * error banner: the question asked was "does this provider work", and "the
   * request did not get through" is an answer to it.
   *
   * A test itself is read-only — it writes only an AuditLog row, and the
   * step's readiness is always derived fresh from the stored credential
   * snapshot, never from a test's outcome. `await load()` afterwards is for
   * PARITY with the readiness cards, and because the credential state it
   * reads can have changed in another tab since this tab last loaded.
   */
  async function runProviderTest(provider: string) {
    setProviderRunning(provider);
    try {
      const response = await fetch("/api/admin/setup/provider-test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const body = (await response.json().catch(() => null)) as
        | { ok?: boolean; message?: string; error?: string }
        | null;
      const ok = body?.ok;
      if (!response.ok || typeof ok !== "boolean") {
        throw new Error(errorMessageFrom(body, "Provider test failed"));
      }
      setProviderResults((current) => ({
        ...current,
        [provider]: { ok, message: body?.message ?? "" },
      }));
      await load();
    } catch (testError) {
      setProviderResults((current) => ({
        ...current,
        [provider]: {
          ok: false,
          message:
            testError instanceof Error
              ? testError.message
              : "Provider test failed",
        },
      }));
    } finally {
      // Compare-and-clear: a slower test left running on a step the operator
      // has since navigated away from must not clear the CURRENT step's
      // running flag when it settles — providerRunning is a single
      // string|null, not one flag per provider, so an unconditional clear
      // here would re-enable whichever step's button happens to be showing.
      setProviderRunning((current) => (current === provider ? null : current));
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

      {moved ? (
        <div
          className="flex items-start justify-between gap-3 rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11"
          role="status"
          data-testid="setup-wizard-moved-notice"
        >
          <p>
            This step changed elsewhere — you have been returned to the next
            step.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setMoved(false)}
          >
            Dismiss
          </Button>
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
            onSelect={select}
          />

          {activeStepId === SETUP_WIZARD_LAUNCH_ID ? (
            <SetupWizardLaunchPanel
              view={view}
              isSiteVisible={payload?.isSiteVisible ?? false}
              environmentSafety={
                payload?.environmentSafety ?? {
                  role: "UNKNOWN",
                  decidedBy: "unresolved",
                  withheldEmail: { available: false },
                }
              }
              permissionMatrix={permissionMatrix}
              onPublishActivity={setLaunchPinned}
            />
          ) : activeStep ? (
            // The frame and the pane are SIBLINGS in one column, in this order.
            // The pane sits below because the frame carries the step's identity
            // — its title, its state badge and C11's defaulted banner. Only
            // ONE of the two panes proved here changes what that banner means:
            // club-time-zone's is the installed-default copy, whose "check it
            // below" sentence now points at something for the first time.
            // club-config's is the read-from-deployment copy (see
            // `defaultedBannerCopy` in `setup-wizard-step-frame.tsx`), which
            // never said "below" in the first place. See `setup-wizard-panes.tsx`
            // for why the pane can not be moved inside the frame instead.
            <div className="space-y-4">
              <SetupWizardStepFrame
                step={activeStep}
                canEdit={canChangeSetupProgress(permissionMatrix)}
                saving={saving}
                previousStep={neighbours.previous}
                nextStep={neighbours.next}
                launchUnlocked={view.allResolved}
                providerTesting={
                  activeStep.action
                    ? providerRunning === activeStep.action.provider
                    : false
                }
                providerResult={
                  activeStep.action
                    ? (providerResults[activeStep.action.provider] ?? null)
                    : null
                }
                onNavigate={select}
                onOpenLaunch={() => select(SETUP_WIZARD_LAUNCH_ID)}
                onProgress={(action) =>
                  void updateProgress(action, activeStep.id)
                }
                onProviderTest={(provider) => void runProviderTest(provider)}
              />
              <SetupWizardStepPane
                stepId={activeStep.id}
                permissionMatrix={permissionMatrix}
              />
            </div>
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
