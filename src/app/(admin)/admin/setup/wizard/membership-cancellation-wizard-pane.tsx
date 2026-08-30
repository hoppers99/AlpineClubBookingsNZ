"use client";

import { MembershipCancellationSettingsPanel } from "@/components/admin/membership-cancellation-settings-panel";

/**
 * The membership cancellation editor, in the wizard (`membership-cancellation`,
 * C22 #260).
 *
 * `MembershipCancellationSettingsPanel` is the same zero-prop, self-fetching,
 * self-gating shape C12/C13/C18 already proved: it fetches
 * `/api/admin/membership-cancellation-settings` for itself, resolves
 * `membership` edit access for itself (`useAdminAreaEditAccess("membership")`,
 * its own `#1940` comment), and heads itself with its own view-only banner.
 * `/admin/membership-cancellation` mounts exactly the same component inside a
 * `Card`; this pane supplies the subordinate heading in its place, for the
 * mount-order reason spelled out on `ClubIdentityWizardPane`.
 *
 * **The area wrinkle the issue named is fixed in the HREF, not the mapping.**
 * The step's readiness check used to link to `/admin/setup/cancellation` — a
 * link-out hub under the `support`-prefixed `/admin/setup`, unreachable to a
 * membership-only officer, the same shape `club-config`'s `#223` fix
 * corrected — so `SETUP_STEP_PERMISSION_AREA["membership-cancellation"]` read
 * `support`. `buildMembershipCancellationCheck` (`setup-readiness.ts`) now
 * points that `href` at the real editor, `/admin/membership-cancellation`,
 * which `ROUTE_AREA_PREFIXES` registers under `membership` — the same area
 * the panel already gates its own edit access on — so the mapping now derives
 * mechanically instead of needing a hand-set override
 * (`setup-wizard-step-tables.ts` carries the full evidence). That is what
 * keeps the step frame's "That page belongs to Membership" and this panel's own
 * "Membership edit access is required" in agreement — and it is also what
 * fixes a real bug the wrong mapping had, not only a copy mismatch: under the
 * old `support` entry, a custom role with support access and no membership
 * access cleared `canViewSetupStepPane`'s gate and then had this panel's own
 * `GET /api/admin/membership-cancellation-settings` 403 the instant it
 * mounted — exactly the failure that gate exists to prevent for every other
 * step. A support-only viewer now gets the ordinary link-out fallback
 * instead, the same as any step whose area they lack.
 *
 * No cross-page caveat to name, unlike `AgeTierWizardPane`:
 * `buildMembershipCancellationCheck` (`setup-readiness.ts`) reads only
 * whether a `MembershipCancellationSetting` row exists at all, and this
 * panel's `PUT` always upserts one — so a save here fully resolves the step's
 * own check, with nothing left to fix on a different screen.
 *
 * The heading sits OUTSIDE the panel and renders unconditionally, for the
 * mount-order reason spelled out on `ClubIdentityWizardPane`.
 */
export function MembershipCancellationWizardPane() {
  return (
    <section className="space-y-3 rounded-md border bg-card p-5">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground">
          Membership cancellation
        </h3>
        <p className="text-sm text-muted-foreground">
          The same editor as Admin &rarr; Membership Cancellation: the
          cancellation warning copy, the rejoin-process text, and which Xero
          contact groups get archived when a cancellation is approved. Saving
          does not tick this step off — use &ldquo;Mark this step done&rdquo;
          above when you are happy with it.
        </p>
      </div>
      <MembershipCancellationSettingsPanel />
    </section>
  );
}

