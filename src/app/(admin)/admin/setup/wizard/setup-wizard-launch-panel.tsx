"use client";

import { useState } from "react";
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
 * - **Lever 1 is real, and it sends no theme.** Making the public site visible
 *   is the theme's `completedAt`, and this panel is the ONLY wizard surface
 *   allowed to set it — D9 puts it here explicitly and takes it away from the
 *   styling step (C7). It goes through `POST /api/admin/site-style/complete-setup`,
 *   which owns the same cache invalidation, audit row and `content`-area check
 *   the site-style PUT does, and touches one column.
 *
 *   IT USED TO USE THAT PUT, and that was a LOST UPDATE (#220 review F3). The
 *   PUT body is `.strict()` and rewrites every theme column, so publishing meant
 *   reading the whole theme on mount and posting it back — and a panel left open
 *   while another administrator changed the club's colours wrote the copy it read
 *   minutes earlier over their work. Reading the theme here at all was the
 *   defect; the panel now holds no theme.
 *
 *   Whether the site is already visible arrives on the wizard's own payload
 *   (`isSiteVisible`), which the shell refetches on focus — so this display
 *   follows the club rather than freezing at mount time, which the panel's own
 *   fetch never did.
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

export function SetupWizardLaunchPanel({
  view,
  isSiteVisible,
  permissionMatrix,
  onPublishActivity,
}: {
  view: SetupWizardView;
  /** From the wizard payload, refreshed by the shell's focus refetch. */
  isSiteVisible: boolean;
  permissionMatrix: AdminPermissionMatrix;
  /**
   * Told the moment a publish starts, and left true afterwards.
   *
   * The shell unmounts this panel when the traversal stops saying `allResolved`,
   * and a refetch can legitimately say that while a publish is in flight — a
   * step going stale under an upgrade, say. Unmounting mid-request would discard
   * the result: the operator would see the panel vanish with no idea whether the
   * site went live. So the panel tells the shell to pin it, and stays pinned
   * once the request finishes — SUCCESS OR FAILURE — so the answer, or the
   * error explaining why there is none, is actually read before it disappears.
   */
  onPublishActivity: (active: boolean) => void;
}) {
  const [published, setPublished] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const canEditSite = permissionMatrix.content === "edit";
  // The server's answer wins for as long as this panel holds one, because the
  // payload behind `isSiteVisible` is a read that may predate the publish.
  const visible = published || isSiteVisible;

  async function makeSiteVisible() {
    setSaving(true);
    setError("");
    onPublishActivity(true);
    try {
      const response = await fetch("/api/admin/site-style/complete-setup", {
        method: "POST",
        credentials: "same-origin",
      });
      const body = (await response.json().catch(() => null)) as {
        isComplete?: boolean;
        error?: string;
      } | null;
      if (!response.ok || body?.isComplete !== true) {
        throw new Error(body?.error ?? "Failed to make the public site visible");
      }
      setPublished(true);
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
          {visible ? (
            <Badge variant="success">Live</Badge>
          ) : (
            <Badge variant="secondary">Not yet visible</Badge>
          )}
        </div>
        {visible ? (
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
        {visible ? null : (
          <ViewOnlyActionButton
            type="button"
            size="sm"
            canEdit={canEditSite}
            describeReason={false}
            disabled={saving}
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
        )}
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
