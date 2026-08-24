"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Globe, Loader2, ServerCog } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { SetupWizardView } from "@/lib/setup-wizard-view";

/**
 * The launch panel (epic #213, **D9**) — the last screen of the journey.
 *
 * D9, quoted: "Setup-done, site-visible and environment-role are three separate
 * facts. The final wizard screen is a launch panel unlocked by setup-done, with
 * two independent levers." So:
 *
 * - **Unlocked by the traversal**, never by this component. `traversal.allResolved`
 *   (#219's F9 export) is the whole gate, and the shell will not render this
 *   panel without it.
 * - **Lever 1 is real.** Making the public site visible is the theme's
 *   `completeSetup` flag, and this panel is the ONLY wizard surface allowed to
 *   set it — D9 puts it here explicitly and takes it away from the styling step
 *   (C7). It is set through the EXISTING `PUT /api/admin/site-style` path, which
 *   already owns the cache invalidation, the audit row and the `content`-area
 *   permission check; the theme values are read first and round-tripped
 *   unchanged, exactly as the site-style wizard does.
 * - **Lever 2 is a stub, and says so.** The environment role belongs to
 *   upstream's ENV-SAFETY work; declaring production is a `.env` action by that
 *   design, so there is nothing here to mutate even once it lands. C9 (#224)
 *   consumes it. This section states what is missing and where it will live
 *   rather than inventing a reading of an undeclared role — #224's own
 *   acceptance criteria forbid that.
 * - **The two are independent.** A configured internal staging site is
 *   legitimately visible AND non-production forever, so neither lever gates the
 *   other and neither is presented as unfinished business.
 * - **Outstanding work is stated, not hidden** (mockup 6). A club that skipped
 *   steps can still open, and is told exactly what it skipped.
 */

interface SiteStyleTheme {
  brandGold: string;
  brandDeep: string;
  brandSafety: string;
  headingFontKey: string;
  bodyFontKey: string;
  logoUrl: string | null;
  logoDataUrl: string | null;
  rawCss: string | null;
  completedAt: string | null;
}

type SiteVisibility = "loading" | "visible" | "hidden" | "forbidden" | "error";

export function SetupWizardLaunchPanel({
  view,
  permissionMatrix,
}: {
  view: SetupWizardView;
  permissionMatrix: AdminPermissionMatrix;
}) {
  const [theme, setTheme] = useState<SiteStyleTheme | null>(null);
  const [visibility, setVisibility] = useState<SiteVisibility>("loading");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const canEditSite = permissionMatrix.content === "edit";

  const loadTheme = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/site-style", {
        credentials: "same-origin",
      });
      if (response.status === 403) {
        setVisibility("forbidden");
        return;
      }
      const body = (await response.json()) as { theme?: SiteStyleTheme };
      if (!response.ok || !body.theme) {
        setVisibility("error");
        return;
      }
      setTheme(body.theme);
      setVisibility(body.theme.completedAt ? "visible" : "hidden");
    } catch {
      setVisibility("error");
    }
  }, []);

  useEffect(() => {
    void loadTheme();
  }, [loadTheme]);

  async function makeSiteVisible() {
    if (!theme) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/site-style", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // The whole theme, round-tripped unchanged. The PUT body is `.strict()`
          // and rewrites every column, so sending only `completeSetup` would be
          // rejected — and sending a partial one would reset the club's colours.
          brandGold: theme.brandGold,
          brandDeep: theme.brandDeep,
          brandSafety: theme.brandSafety,
          headingFontKey: theme.headingFontKey,
          bodyFontKey: theme.bodyFontKey,
          logoUrl: theme.logoUrl,
          logoDataUrl: theme.logoDataUrl,
          rawCss: theme.rawCss ?? "",
          completeSetup: true,
        }),
      });
      const body = (await response.json().catch(() => null)) as {
        theme?: SiteStyleTheme;
        error?: string;
      } | null;
      if (!response.ok || !body?.theme) {
        throw new Error(body?.error ?? "Failed to make the public site visible");
      }
      setTheme(body.theme);
      setVisibility(body.theme.completedAt ? "visible" : "hidden");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to make the public site visible",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="space-y-4 rounded-md border bg-card p-5"
      data-testid="setup-wizard-launch-panel"
    >
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Ready to open</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Every step in the journey is either done or deliberately skipped. Two
          separate things are left, and neither one depends on the other.
        </p>
      </div>

      {view.outstanding.length > 0 ? (
        <div
          className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11"
          data-testid="setup-wizard-outstanding"
        >
          <p className="font-medium">Still outstanding, by your own choice:</p>
          <ul className="mt-1 space-y-1">
            {view.outstanding.map((item) => (
              <li key={item.id}>
                {item.title}
                {item.deferred ? " — skipped for now" : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <AdminViewOnlySectionBanner canEdit={canEditSite}>
        Content edit access is required to make the public site visible.
      </AdminViewOnlySectionBanner>

      <div className="space-y-3 rounded-md border p-4">
        <div className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-foreground" />
          <h3 className="text-base font-semibold text-foreground">
            Make the public site visible
          </h3>
          {visibility === "visible" ? (
            <Badge variant="success">Live</Badge>
          ) : visibility === "hidden" ? (
            <Badge variant="secondary">Not yet visible</Badge>
          ) : null}
        </div>
        {visibility === "loading" ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking whether the public site is visible
          </p>
        ) : visibility === "forbidden" ? (
          <p className="text-sm text-muted-foreground">
            Your admin role cannot read the site style settings, so this lever is
            not available to you. An administrator with Content access can open
            the public site.
          </p>
        ) : visibility === "error" ? (
          <p className="text-sm text-danger-11">
            Could not read whether the public site is visible. Try again shortly.
          </p>
        ) : visibility === "visible" ? (
          <p className="text-sm text-muted-foreground">
            The public site is live. Visitors see the club&apos;s pages rather
            than the holding screen.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Visitors currently see the holding screen. Making the site visible
            publishes the club&apos;s public pages with the styling you have set.
          </p>
        )}
        {error ? <p className="text-sm text-danger-11">{error}</p> : null}
        {visibility === "hidden" ? (
          <ViewOnlyActionButton
            type="button"
            size="sm"
            canEdit={canEditSite}
            describeReason={false}
            disabled={saving || !theme}
            onClick={makeSiteVisible}
            data-testid="setup-wizard-make-site-visible"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            Make the public site visible
          </ViewOnlyActionButton>
        ) : null}
      </div>

      <div
        className="space-y-2 rounded-md border p-4"
        data-testid="setup-wizard-environment-role"
      >
        <div className="flex items-center gap-2">
          <ServerCog className="h-5 w-5 text-foreground" />
          <h3 className="text-base font-semibold text-foreground">
            Confirm what this instance is for
          </h3>
          <Badge variant="secondary">Not yet available</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Whether this installation is the club&apos;s real site or a test copy
          decides whether it may email the real membership. That role is a
          property of the deployment rather than of your data, so it is declared
          in the environment (<code>.env</code>) and never switched on from this
          screen.
        </p>
        <p className="text-sm text-muted-foreground">
          Until the environment-safety feature lands, this wizard cannot tell you
          which role you are running as. When it does, this panel will name the
          role, say where that answer came from, and list which sends are held
          back while the role is anything other than production. Nothing here is
          waiting on you in the meantime — the public site lever above is
          independent of it.
        </p>
      </div>
    </section>
  );
}
