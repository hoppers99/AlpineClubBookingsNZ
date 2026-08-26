"use client";

import { Eye, EyeOff } from "lucide-react";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { PolicyFeedback } from "@/components/admin/booking-policies/policy-feedback";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";

interface SetupSurfacesDraft {
  legacySurfacesHidden: boolean;
}

/**
 * The setup-surfaces settings section (epic #213, child C8, #223; D8).
 *
 * ONE SETTING: whether this club still sees the legacy setup surfaces — the
 * readiness cards on this page, the four `/admin/setup` drill-down hubs, and
 * Site Style's own Finish-setup control. The wizard is the destination (D6);
 * this is the switch that retires what it replaced, once a club is satisfied the
 * journey covers its needs.
 *
 * IT LIVES ON `/admin/setup`, AND THAT PLACEMENT IS THE DESIGN RATHER THAN
 * CONVENIENCE. The page itself stays reachable in both positions — only the
 * cards and the hub links go — so the switch is always where an operator last
 * saw the thing it hides. Putting it behind the flag it sets would reproduce
 * exactly the trap `feature-routes.ts`'s `exemptPaths` exists for: "gating a
 * guided setup surface behind its own flag makes it unreachable in the only
 * state it exists to fix".
 *
 * CANONICAL SETTINGS PATTERN, unmodified (`ARCHITECTURE.md` → "Admin/member
 * layer"): read-only on mount, one staged Edit → Save/Cancel step, nothing
 * auto-persists on toggle, Cancel reverts to the last saved snapshot, Save
 * writes once and is dirty-gated through the hook's `isDirty` rather than by a
 * comparison in the route. The FRAME — banner and feedback region — is rendered
 * in every state, above the loading branch, so a failed first load never mounts
 * the section together with an already-populated alert.
 *
 * Cancel is a plain `Button`, like every sibling section's: it discards rather
 * than writes, so a view-only admin who somehow reached edit mode is not being
 * stopped from anything. Edit and Save are the two gated controls, both
 * `describeReason={false}` under the banner this file renders itself.
 */
export function SetupSurfacesSection({
  canEdit,
  onSaved,
}: {
  canEdit: boolean | undefined;
  /** Lets the page hide or restore its own cards without a round trip. */
  onSaved: (settings: SetupSurfacesDraft) => void;
}) {
  const section = useSectionEditState<SetupSurfacesDraft>({
    load: async (signal) => {
      const response = await fetch("/api/admin/setup/surfaces", {
        cache: "no-store",
        credentials: "same-origin",
        signal,
      });
      if (!response.ok) throw new Error("Failed to load setup surface settings");
      const body = (await response.json()) as { settings: SetupSurfacesDraft };
      return body.settings;
    },
    save: async (draft) => {
      const response = await fetch("/api/admin/setup/surfaces", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (response.status === 403) throw new ForbiddenSaveError();
      if (!response.ok) {
        // The route answers a retryable 503 when two administrators save at
        // once (its Serializable transaction aborts the loser). That is worth
        // repeating verbatim — "try again shortly" is actionable and the
        // generic fallback is not — so the server's own message wins whenever
        // it sent one.
        const failure = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          failure?.error ?? "Failed to save setup surface settings",
        );
      }
      const body = (await response.json()) as { settings: SetupSurfacesDraft };
      onSaved(body.settings);
      return body.settings;
    },
    successMessage: (saved) =>
      saved.legacySurfacesHidden
        ? "The legacy setup surfaces are now hidden. Everything they opened is in the wizard."
        : "The legacy setup surfaces are shown again.",
    loadErrorFallback: "Failed to load setup surface settings",
    saveErrorFallback: "Failed to save setup surface settings",
    isDirty: (draft, saved) =>
      draft.legacySurfacesHidden !== saved.legacySurfacesHidden,
  });
  const draft = section.draft;

  return (
    <section id="setup-surfaces" className="space-y-3">
      <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
        Your admin role can view which setup surfaces are shown but cannot change
        them. Support edit access is required.
      </AdminViewOnlySectionBanner>
      <PolicyFeedback
        error={section.error}
        success={section.success}
        onClearError={() => section.setError("")}
        onClearSuccess={() => section.setSuccess("")}
      />
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {draft?.legacySurfacesHidden ? (
                <EyeOff className="h-5 w-5 shrink-0 text-muted-foreground" />
              ) : (
                <Eye className="h-5 w-5 shrink-0 text-foreground" />
              )}
              <CardTitle className="text-base">Setup surfaces</CardTitle>
            </div>
            <CardDescription>
              The setup wizard walks a club through everything below. Once you
              are happy it covers what you need, hide the older checklist and
              drill-down hubs so there is one way in. Nothing is deleted, no
              setting changes, and switching this back brings them straight back.
            </CardDescription>
          </div>
          {draft && !section.editing ? (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              onClick={section.startEditing}
            >
              Edit
            </ViewOnlyActionButton>
          ) : null}
        </CardHeader>
        <CardContent className="space-y-4">
          {section.loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner size="sm" label="Loading setup surface settings" />
              Loading setup surface settings
            </div>
          ) : null}
          {!section.loading && !draft ? (
            <Button
              variant="outline"
              disabled={section.loading || section.saving}
              onClick={() => void section.reload()}
            >
              Try again
            </Button>
          ) : null}
          {draft ? (
            <>
              <div className="flex items-start gap-3">
                <Checkbox
                  id="legacy-setup-surfaces-hidden"
                  checked={draft.legacySurfacesHidden}
                  onCheckedChange={(checked) =>
                    section.setDraft({ legacySurfacesHidden: checked === true })
                  }
                  disabled={!section.editing || section.saving}
                  className="mt-1"
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <label
                    htmlFor="legacy-setup-surfaces-hidden"
                    className="text-sm font-medium text-foreground"
                  >
                    Hide the readiness checklist and the setup hubs
                  </label>
                  <p className="text-sm text-muted-foreground">
                    {draft.legacySurfacesHidden
                      ? "Hidden. This page offers the wizard, and Initial Setup, Finance, Booking Rules and Operational Integrations send you there. Every page they opened is still reachable — from the wizard's steps, or from the sidebar."
                      : "Shown. The readiness cards and the four setup hubs appear on this page as they always have, alongside the wizard."}
                  </p>
                </div>
              </div>
              {section.editing ? (
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    disabled={section.saving}
                    onClick={section.cancelEditing}
                  >
                    Cancel
                  </Button>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    disabled={!section.dirty || section.saving}
                    onClick={() => void section.save()}
                  >
                    Save
                  </ViewOnlyActionButton>
                </div>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>
    </section>
  );
}
