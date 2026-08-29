"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { SETUP_READINESS_INPUT_CHANGED_EVENT } from "@/lib/setup-readiness-events";
import type { SetupStepId } from "@/lib/setup-step-registry";
import {
  buildSetupWizardView,
  canChangeSetupProgress,
  resolveInitialStepId,
  type SetupWizardPayload,
} from "@/lib/setup-wizard-view";
import {
  SETUP_WIZARD_ENVIRONMENT_ID,
  SETUP_WIZARD_LAUNCH_ID,
  SetupWizardRail,
  type SetupWizardRailSelection,
} from "./setup-wizard-rail";
import { SetupWizardLaunchPanel } from "./setup-wizard-launch-panel";
import { SetupWizardEnvironmentPanel } from "./setup-wizard-environment-panel";
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
 *    module off must remove its steps from the rail without a page reload. When
 *    C5 shipped, the modules editor was only ever a DIFFERENT admin page, so
 *    the honest mechanism was a refetch when the operator comes back to this
 *    tab or window — exactly when the flags can have changed. That is still not
 *    a subscription and still does not claim to be: a flag changed in another
 *    tab shows up here the moment this tab is focused, and the Refresh button
 *    forces it.
 *
 *    **C13 (#239) put the toggles ON this screen**, as the `feature-flags` and
 *    `address-autocomplete` panes, which is where D5's reflow-beside-the-rail
 *    actually happens. That save never leaves the tab, so it reaches the shell
 *    through the third trigger below rather than through either of these two.
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

/**
 * How long after a readiness-input-changed event a subsequent "moved" is still
 * attributed to it (F4, #239 fix round). Generous rather than tight: the whole
 * sequence — the pane's PUT resolving, `emitSetupReadinessInputChanged`, this
 * client's own refetch, the re-render that discovers the step is gone — is a
 * handful of network round trips on the same tab, not a window an operator
 * could plausibly fill with an unrelated cause in the meantime.
 */
const LOCAL_SAVE_ATTRIBUTION_WINDOW_MS = 5000;

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
   * F4 (#239 fix round): whether THIS move was caused by a save this client
   * just watched happen, so the notice can say so instead of leaving the
   * operator's own success message to die with the remount that caused it.
   *
   * `SetupWizardStepPane` keys its wrapper by `stepId` (`setup-wizard-panes.tsx`),
   * so the self-removal case — unchecking `address-autocomplete` in the modules
   * pane and saving — unmounts `ModulesSection` in the very same commit that
   * moves the operator elsewhere. `ModulesSection`'s own "Module settings
   * saved." message is local state, and it goes with it: the operator watches
   * Save turn into a notice that talks only about navigation, with no word that
   * the write it replaced actually succeeded. `lastLocalSaveAtRef` below is
   * stamped by the readiness-input-changed listener — the only signal this
   * client has that a pane just wrote something — and read once, here, when a
   * move is about to be reported.
   */
  const [movedByLocalSave, setMovedByLocalSave] = useState(false);
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

  /**
   * F6 (#238 fix round): three independent triggers can call `load()` —
   * mount, the focus/visibility listener, and C12's readiness-input-changed
   * event — and nothing serialised them. Two overlapping requests used to
   * resolve in NETWORK order rather than CALL order: a pane's save-triggered
   * refetch racing a focus-triggered refetch could have the focus request
   * (started first, no new facts to report) resolve LAST and silently
   * overwrite the pane's own fresher read with stale, pre-save state — the
   * operator would see the exact repaint their save was supposed to produce
   * flicker back to what it replaced.
   *
   * `loadSeqRef` is incremented on every CALL, not every resolution, so
   * "latest wins" means latest STARTED, matching what the operator actually
   * did last. A response applies its result only if no newer call has started
   * since — stale calls still run to completion (nothing to cancel — the
   * request itself keeps executing on the network), they just no longer write
   * `payload`, `error` or `loading`.
   */
  const loadSeqRef = useRef(0);

  /**
   * The stamp `movedByLocalSave` above reads. `0` means "no local save is
   * outstanding"; any other value is the `Date.now()` the readiness-input-
   * changed listener last fired at. Consumed (reset to `0`) the moment a move
   * is reported, so a LATER, unrelated move — the flags changed in another
   * tab, say, read on the next focus refetch — cannot reuse a stale save's
   * attribution.
   */
  const lastLocalSaveAtRef = useRef(0);

  const load = useCallback(async () => {
    const seq = (loadSeqRef.current += 1);
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
      if (seq !== loadSeqRef.current) return; // a newer load has since started; drop this stale result
      setPayload(body);
    } catch (loadError) {
      if (seq !== loadSeqRef.current) return;
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load the setup wizard",
      );
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // D4/D5: a module flag can still be changed on `/admin/modules` in another
  // tab — C13 added the inline route, it did not remove the page. Coming back
  // to this tab is the moment to re-read for that case; the in-tab case is the
  // event listener below.
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
      // F4 (#239 fix round): stamped BEFORE the refetch, not after — the
      // move this save can cause is discovered by the effects below reacting
      // to the refetch's OWN result, and that result can land before this
      // function returns if `load()` ever settles synchronously (it never
      // does today, but stamping first costs nothing and removes the
      // ordering assumption).
      lastLocalSaveAtRef.current = Date.now();
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

  /**
   * Report a move, attributing it to a local save when `lastLocalSaveAtRef`
   * was stamped recently enough (F4, #239 fix round). Shared by both
   * `setMoved(true)` call sites below — the explicit-selection case and the
   * no-selection case are the same defect from the operator's point of view,
   * and `ModulesSection`'s remount destroys its own "saved" message the same
   * way regardless of which one fired.
   *
   * Consumes the stamp: once read here, it is reset to `0` so a later,
   * unrelated move (the flags changed in another tab, discovered on the next
   * focus refetch) cannot reuse this save's attribution.
   */
  const reportMoved = useCallback(() => {
    const stampedAt = lastLocalSaveAtRef.current;
    const causedByLocalSave =
      stampedAt > 0 &&
      Date.now() - stampedAt <= LOCAL_SAVE_ATTRIBUTION_WINDOW_MS;
    lastLocalSaveAtRef.current = 0;
    setMovedByLocalSave(causedByLocalSave);
    setMoved(true);
  }, []);

  // The selection has to survive a refetch, but not survive a step DISAPPEARING
  // — which is precisely what happens when the module owning it is switched off
  // (D4). Resolving it on every render, against the freshly-loaded view, is what
  // makes "the rail updates without a page reload" true for the frame as well as
  // for the rail.
  const activeStepId = useMemo(() => {
    if (!view) return null;
    // The environment panel is ALWAYS reachable (D17, #246) — nothing gates
    // reading a fact — so unlike the launch sentinel this needs no unlock
    // check. It survives a refetch for the same reason a step selection does.
    if (selectedId === SETUP_WIZARD_ENVIRONMENT_ID) {
      return view.environment.length > 0
        ? SETUP_WIZARD_ENVIRONMENT_ID
        : view.currentStepId;
    }
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
  // module owning it was switched off, or somebody else settled the step and
  // moved the frontier. Landing them somewhere else without a word is the same
  // defect the frame's own Back control used to teleport with, before C21
  // (#252) retired it in favour of the rail — one refetch later.
  //
  // C13 (#239) is why the notice no longer says the step changed "elsewhere":
  // an operator standing on `address-autocomplete` can now switch that very
  // module off in the pane below, from this screen, and be moved by their own
  // save. "Elsewhere" was true of every case C5 could produce and is false of
  // that one, so the sentence states the OUTCOME rather than guessing where —
  // "no longer available" also covers the second cause, a step that still
  // exists but has been put back behind the frontier by a stale predecessor.
  //
  // The selection is cleared at the same moment, deliberately: left set, this
  // would re-fire on every subsequent refetch, and the operator has already been
  // moved once.
  //
  // `reportMoved()` (F4, #239 fix round), not a bare `setMoved(true)`: the
  // save that removed this step also destroyed `ModulesSection`'s own
  // "Module settings saved." message when the pane remounted under a new
  // `stepId` key, so the notice prefixes itself with a word about the write
  // whenever a readiness-input-changed event fired recently enough to be
  // this save. See `reportMoved` above and `lastLocalSaveAtRef`'s docblock.
  useEffect(() => {
    if (!view || selectedId === null) return;
    const resolved =
      selectedId === SETUP_WIZARD_ENVIRONMENT_ID
        ? view.environment.length > 0
          ? SETUP_WIZARD_ENVIRONMENT_ID
          : view.currentStepId
        : selectedId === SETUP_WIZARD_LAUNCH_ID
          ? view.allResolved || launchPinned
            ? SETUP_WIZARD_LAUNCH_ID
            : view.currentStepId
          : resolveInitialStepId(view, selectedId);
    if (resolved === selectedId) return;
    setSelectedId(null);
    reportMoved();
  }, [view, selectedId, launchPinned, reportMoved]);

  /**
   * The same courtesy when there was NO explicit selection to invalidate.
   *
   * The effect above can only speak for an operator who clicked a rail row:
   * with `selectedId === null` they are simply riding the traversal's own
   * `currentStepId`, which moves silently by design. That was harmless until
   * C13 (#239), because nothing an operator did ON this screen could delete the
   * step under them — the modules editor was another page, and coming back to
   * this tab is a navigation they performed themselves.
   *
   * It is not harmless now. An operator whose resume point IS
   * `address-autocomplete` can clear that module's checkbox in the pane below,
   * press Save, and watch the whole frame become a different step — their own
   * action, but not an action that named this step, and nothing on screen
   * connecting the two.
   *
   * The test is deliberately narrow: the step that was on screen has left the
   * JOURNEY, not merely been overtaken. A frontier that moves under a completed
   * step is the wizard doing exactly what the operator asked and needs no
   * notice, and firing there would put a warning on every ordinary "mark done
   * and move on".
   */
  const shownStepRef = useRef<SetupWizardRailSelection | null>(null);
  useEffect(() => {
    const previous = shownStepRef.current;
    shownStepRef.current = activeStepId;
    if (!view || selectedId !== null) return;
    // No `previous === SETUP_WIZARD_LAUNCH_ID` arm here (F5, #239 fix round):
    // it cannot occur. `activeStepId`'s own `useMemo` above resolves the
    // launch id back to `view.currentStepId` the instant `allResolved` goes
    // false, in the SAME render that would otherwise start invalidating a
    // `selectedId === LAUNCH_ID` selection — so by the time that
    // invalidation's `setSelectedId(null)` has actually committed and this
    // effect runs with `selectedId === null`, `shownStepRef.current` was
    // already overwritten with the real step one render earlier. `previous`
    // can therefore never be observed holding `SETUP_WIZARD_LAUNCH_ID` at the
    // point where the guard above has already required `selectedId === null`.
    if (previous === null) return;
    if (previous === activeStepId) return;
    // Nor an environment-panel arm, and for a stronger reason than the launch
    // one above: that panel is ALWAYS reachable (D17, #246), so nothing can
    // move an operator off it involuntarily and there is no such move to
    // apologise for.
    if (previous === SETUP_WIZARD_ENVIRONMENT_ID) return;
    if (view.steps.some((step) => step.id === previous)) return;
    reportMoved();
  }, [view, selectedId, activeStepId, reportMoved]);

  /** Any deliberate move retires the notice — they can see where they are now. */
  const select = useCallback((id: SetupWizardRailSelection) => {
    setMoved(false);
    setMovedByLocalSave(false);
    // Leaving the launch panel releases its pin: the operator has read whatever
    // the publish had to say and chosen to go elsewhere.
    if (id !== SETUP_WIZARD_LAUNCH_ID) setLaunchPinned(false);
    setSelectedId(id);
  }, []);

  const activeStep =
    view &&
    activeStepId &&
    activeStepId !== SETUP_WIZARD_LAUNCH_ID &&
    activeStepId !== SETUP_WIZARD_ENVIRONMENT_ID
      ? (view.steps.find((step) => step.id === activeStepId) ?? null)
      : null;

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
            {movedByLocalSave
              ? "Your module settings were saved. That step is no longer " +
                "available — you have been moved to the next one."
              : "That step is no longer available — you have been moved to " +
                "the next one."}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setMoved(false);
              setMovedByLocalSave(false);
            }}
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
            environmentCount={view.environment.length}
            environmentNeedsAttention={view.environment.some(
              (row) => row.status !== "complete",
            )}
            onSelect={select}
          />

          {activeStepId === SETUP_WIZARD_ENVIRONMENT_ID ? (
            <SetupWizardEnvironmentPanel
              rows={view.environment}
              // The same gate the step frame's provider test uses: a test
              // writes an audit row, so it is `support: edit`, which is the one
              // answer for the whole wizard (see `canChangeSetupProgress`).
              canEdit={canChangeSetupProgress(permissionMatrix)}
              providerRunning={providerRunning}
              providerResults={providerResults}
              onProviderTest={(provider) => void runProviderTest(provider)}
            />
          ) : activeStepId === SETUP_WIZARD_LAUNCH_ID ? (
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
            // — its title, its state badge and C11's defaulted banner. Of the
            // steps with a pane — two change what that banner MEANS:
            // `club-time-zone` and C19's `lodges` both carry the
            // installed-default copy, whose "check it below" sentence points at
            // something real on a step that has a pane. Every other
            // pane's step carries the read-from-deployment copy (C20's
            // `seed-admin` included — its create form issues no fetch on
            // mount, so it adds no request noise here).
            // `setup-wizard-panes.tsx` for why the pane can not be moved inside
            // the frame instead.
            <div className="space-y-4">
              <SetupWizardStepFrame
                step={activeStep}
                canEdit={canChangeSetupProgress(permissionMatrix)}
                saving={saving}
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
