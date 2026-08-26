"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Save,
  ServerCog,
} from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { MODULE_KEYS, type ModuleKey, type ModuleSettingsValues } from "@/config/modules";
import { useScrollToFeedback } from "@/hooks/use-scroll-to-feedback";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { emitSetupReadinessInputChanged } from "@/lib/setup-readiness-events";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";

/**
 * The module activation editor, as an EMBEDDABLE SECTION (epic #213, child C13,
 * #239; owner decision D16).
 *
 * ## Why this is a section and not a page any more
 *
 * It was the whole of `/admin/modules/page.tsx` — a page-is-component that
 * fetched for itself, resolved `support` edit access for itself and headed
 * itself with its own view-only banner. That is already the shape C12's pane
 * registry mounts, so the only thing standing between the module toggles and
 * the wizard was the file they lived in. The toggles are the single most
 * wizard-like moment mockup 2 promised (D5): switching Xero on adds its steps to
 * the rail, beside the checkbox that added them. `/admin/modules` keeps the
 * behaviour it had — the page is now a shell around this section, the shape
 * `/admin/appearance/identity` already uses for `ClubIdentityPanel`.
 *
 * ## Zero props, and NO HEADING OF ITS OWN
 *
 * Both hosts supply the heading, because the two need different ones: the page
 * needs the screen's `h1`, and the wizard — which already spends its `h1` on
 * "Setup wizard" — needs a subordinate one inside its pane. That is
 * `ClubIdentityPanel`'s arrangement exactly: `/admin/appearance/identity` heads
 * it with a `CardTitle`, `setup-wizard-panes.tsx` heads it with an `h3`, and the
 * panel itself carries neither. The Refresh/Save toolbar therefore comes with
 * the section rather than sitting beside a heading it no longer owns, so on
 * `/admin/modules` the two buttons now open the section instead of sharing the
 * title's row. Same controls, same states, one row lower.
 *
 * ## The view-only banner stays HERE
 *
 * `describeReason={false}` on the Save below is a STATIC opt-out
 * (`view-only-banner-contract.test.ts`), which requires a banner in the SAME
 * file — so the banner and the control it explains move together or not at all.
 * It is also hoisted above the loading branch, unchanged from the page, so a
 * slow first load never mounts an already-populated live region.
 *
 * ## Saving announces itself
 *
 * A module flag is a readiness INPUT: it decides which steps apply at all
 * (`setup-step-registry.ts` derives applicability from the flags), so a save
 * here changes the wizard's step set, its denominator and its percentage. When
 * this section is mounted INSIDE the wizard the operator never leaves the tab,
 * so neither of the shell's focus/visibility refetches can fire — hence
 * `emitSetupReadinessInputChanged()` after a successful save, the same
 * announcement `ClubIdentityPanel` and `ClubTimeZonePanel` make. It names no
 * wizard, and on `/admin/modules` — where nothing is listening — it costs one
 * no-op dispatch.
 */

type ModuleReadinessStatus =
  | "ready"
  | "admin_disabled"
  // #2306 added a `not_available_yet` state for the memberGuests flag, which
  // gated nothing in that release. #2307 shipped the behaviour, removing the
  // only producer, so the state and its branches go with it.
  | "credentials_missing";

interface ModuleStatus {
  key: ModuleKey;
  label: string;
  description: string;
  adminEnabled: boolean;
  effectiveEnabled: boolean;
  readiness: {
    status: ModuleReadinessStatus;
    message: string;
    dependencies: string[];
  };
}

interface ModulesResponse {
  settings: ModuleSettingsValues;
  modules: ModuleStatus[];
  updatedAt: string | null;
  updatedByMemberId: string | null;
}

function responseErrorMessage(body: unknown, fallback: string) {
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

function readinessVariant(
  status: ModuleReadinessStatus,
): BadgeProps["variant"] {
  if (status === "ready") return "success";
  if (status === "credentials_missing") return "warning";
  return "secondary";
}

function readinessLabel(status: ModuleReadinessStatus) {
  if (status === "ready") return "Enabled";
  if (status === "credentials_missing") return "Needs setup";
  return "Disabled";
}

// Modules whose "Needs setup" state has somewhere to deep-link to (#2080). C4/C5
// add their providers here as their wizards land.
//
// `analytics` points at the Integrations HUB rather than at a setup route of its
// own, because it has none by design: the owner's #2573 decision put Google
// Analytics on that hub as a peer card whose configuration opens in place, and
// expressly ruled out a dedicated analytics setup route. Without this entry
// analytics was the one module in the tree that could report `credentials_missing`
// with no clickable route to its configuration — on the screen where the #2573
// hard cutover is most likely to be discovered by an operator who has not read the
// release note, and two rows away from the Xero and Google sign-in cards that do
// show the affordance.
const MODULE_SETUP_HREFS: Partial<Record<ModuleKey, string>> = {
  xeroIntegration: "/admin/xero/setup",
  googleLogin: "/admin/google/setup",
  analytics: "/admin/integrations",
  // The Alpine Central Server setup lives on the Integrations hub (as a card
  // opening /admin/alpine-server/setup); the module's "Set up" affordance points
  // at the hub, matching the analytics pattern.
  alpineCentralServer: "/admin/integrations",
};

function getReadiness(
  module: ModuleStatus,
  adminEnabled: boolean,
): ModuleStatus["readiness"] {
  if (!adminEnabled) {
    return {
      ...module.readiness,
      status: "admin_disabled",
      message: `${module.label} is turned off in the admin Modules settings.`,
    };
  }

  // This survives an optimistic re-render of the draft state: a module that
  // needs credentials must not flip to a green "Enabled" the moment the admin
  // ticks the box.
  if (module.readiness.status === "credentials_missing") {
    return module.readiness;
  }

  return {
    ...module.readiness,
    status: "ready",
    message: `${module.label} is enabled.`,
  };
}

function cloneSettings(settings: ModuleSettingsValues): ModuleSettingsValues {
  return Object.fromEntries(
    MODULE_KEYS.map((key) => [key, settings[key]]),
  ) as ModuleSettingsValues;
}

export function ModulesSection() {
  // Module activation is a support-area setting; a support:view admin sees it
  // read-only (#1940). The PUT route enforces support:edit.
  const canEdit = useAdminAreaEditAccess("support");
  const [payload, setPayload] = useState<ModulesResponse | null>(null);
  const [draft, setDraft] = useState<ModuleSettingsValues | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  // Named for what it now is: the top of the SECTION, which on `/admin/modules`
  // is a little below the page heading and in the wizard is inside the pane.
  const sectionRef = useRef<HTMLDivElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const { scrollToError, scrollToTop } = useScrollToFeedback();

  async function loadModules() {
    setLoading(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/modules", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as ModulesResponse | { error?: string };
      if (!response.ok || !("settings" in body) || !("modules" in body)) {
        throw new Error(responseErrorMessage(body, "Failed to load modules"));
      }
      setPayload(body);
      setDraft(cloneSettings(body.settings));
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : "Failed to load modules",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadModules();
  }, []);

  useEffect(() => {
    if (error) scrollToError(feedbackRef);
  }, [error, scrollToError]);

  useEffect(() => {
    if (savedMessage) scrollToTop(sectionRef);
  }, [savedMessage, scrollToTop]);

  const modules = useMemo(() => {
    if (!payload || !draft) return [];
    return payload.modules.map((module) => ({
      ...module,
      adminEnabled: draft[module.key],
      effectiveEnabled: draft[module.key],
      readiness: getReadiness(module, draft[module.key]),
    }));
  }, [payload, draft]);

  const dirty =
    payload !== null &&
    draft !== null &&
    MODULE_KEYS.some((key) => payload.settings[key] !== draft[key]);

  function setModuleEnabled(key: ModuleKey, enabled: boolean) {
    setDraft((current) =>
      current
        ? {
            ...current,
            [key]: enabled,
          }
        : current,
    );
    setSavedMessage("");
  }

  async function saveModules() {
    if (!draft) return;

    setSaving(true);
    setError("");
    setSavedMessage("");

    try {
      const response = await fetch("/api/admin/modules", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: draft }),
      });
      if (response.status === 403) {
        throw new Error(ADMIN_FORBIDDEN_SAVE_REASON);
      }
      const body = (await response.json()) as ModulesResponse | { error?: string };
      if (!response.ok || !("settings" in body) || !("modules" in body)) {
        throw new Error(responseErrorMessage(body, "Failed to save modules"));
      }
      setPayload(body);
      setDraft(cloneSettings(body.settings));
      setSavedMessage("Module settings saved.");
      // The module flags decide which setup steps APPLY at all, so this save
      // can add or remove rail rows and move the wizard's denominator — the
      // D4/D5 reflow. Announced only after the write succeeded: an optimistic
      // emit would have the wizard re-read the values it already holds and
      // report them as the new truth. See `setup-readiness-events.ts`.
      emitSetupReadinessInputChanged();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Failed to save modules",
      );
    } finally {
      setSaving(false);
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the module settings but cannot change them.
      Support edit access is required.
    </AdminViewOnlySectionBanner>
  );

  if (loading && !payload) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="flex min-h-[320px] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      <div ref={sectionRef} className="space-y-8">
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void loadModules()}
          disabled={loading || saving}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh
        </Button>
        <ViewOnlyActionButton
          canEdit={canEdit}
          describeReason={false}
          type="button"
          onClick={() => void saveModules()}
          disabled={!dirty || saving || draft === null}
        >
          {saving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save
        </ViewOnlyActionButton>
      </div>

      {(error || savedMessage) && (
        <div
          ref={feedbackRef}
          role={error ? "alert" : "status"}
          tabIndex={error ? -1 : undefined}
          className={
            error
              ? "scroll-mt-20 rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11 focus:outline-none"
              : "rounded-md border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11"
          }
        >
          {error || savedMessage}
        </div>
      )}

      <div className="rounded-md border border-border bg-card px-4 py-3">
        <div className="flex items-start gap-3">
          <ServerCog className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>
              Module activation is stored in the database and does not store
              secrets, tokens, tenant ids, or provider credentials.
            </p>
            <p>
              A module is available across the site whenever it is enabled here.
              Some modules still need their own setup (for example Xero
              credentials) before they can do useful work.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {modules.map((module) => {
          const checkboxId = `module-${module.key}`;
          const statusIcon = module.effectiveEnabled ? (
            <CheckCircle2 className="h-4 w-4 text-success-11" />
          ) : (
            <AlertCircle className="h-4 w-4 text-warning-11" />
          );

          return (
            <Card key={module.key}>
              <CardHeader className="space-y-3">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id={checkboxId}
                    checked={module.adminEnabled}
                    onCheckedChange={(checked) =>
                      setModuleEnabled(module.key, checked === true)
                    }
                    disabled={saving || !canEdit}
                    className="mt-1"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base">
                        <label htmlFor={checkboxId}>{module.label}</label>
                      </CardTitle>
                      <Badge variant={module.adminEnabled ? "success" : "secondary"}>
                        {module.adminEnabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </div>
                    <CardDescription className="mt-1">
                      {module.description}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                  {statusIcon}
                  <div>
                    <Badge
                      variant={readinessVariant(module.readiness.status)}
                      className="mb-2"
                    >
                      {readinessLabel(module.readiness.status)}
                    </Badge>
                    <p>{module.readiness.message}</p>
                    {module.readiness.status === "credentials_missing" &&
                    MODULE_SETUP_HREFS[module.key] ? (
                      <Link
                        href={MODULE_SETUP_HREFS[module.key] as string}
                        className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-foreground underline decoration-brand-gold/70 decoration-2 underline-offset-4"
                      >
                        Set up
                        <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                      </Link>
                    ) : null}
                  </div>
                </div>

                {module.readiness.dependencies.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      Dependencies
                    </p>
                    <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                      {module.readiness.dependencies.map((dependency) => (
                        <li key={dependency}>{dependency}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
      </div>
    </div>
  );
}
