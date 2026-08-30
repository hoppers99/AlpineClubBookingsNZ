"use client";

import { AgeTierSection } from "@/app/(admin)/admin/age-tier-settings/age-tier-section";

/**
 * The age-tier boundary editor, in the wizard (`age-tiers`).
 *
 * `AgeTierSection` is C18's (#249) repeat of the C13 move above: zero props,
 * fetches `/api/admin/age-tier-settings` for itself, resolves `bookings`
 * edit access for itself, and heads itself with its own view-only banner.
 * `/admin/age-tier-settings` mounts exactly the same component under its own
 * `AdminPageHeader`; this pane supplies the subordinate heading in its place,
 * for the mount-order reason spelled out on `ClubIdentityWizardPane`.
 *
 * SIMPLER than the modules pane: this step owns no OTHER step's existence, so
 * there is no rail-redraw or self-removal case to narrate here — saving
 * changes what the `age-tiers` check itself reports, nothing else in the
 * journey.
 *
 * **The orientation paragraph carries the pane copy caveat (dossier B.4).**
 * `buildAgeTierCheck` (`setup-readiness.ts`) is two checks in one: whether
 * tiers are configured at all, which this section fully controls, and
 * whether any membership type set to "subscription required based on age
 * tier" actually has a tier that requires one
 * (`basedOnAgeTierTypesWithoutSubscribingTier`). That second half is fixed on
 * `/admin/membership-types`, a screen this pane never touches — so a perfect
 * save here can still leave the step amber, and an operator who only looks
 * at this pane has no way to discover why. The paragraph says so, the same
 * way `ModulesWizardPane`'s names the address-autocomplete split rather than
 * leaving it to be found by trial and error.
 */
export function AgeTierWizardPane() {
  return (
    <section className="space-y-3 rounded-md border bg-card p-5">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground">
          Age and membership rules
        </h3>
        <p className="text-sm text-muted-foreground">
          The same editor as Admin &rarr; Age Group Settings. This step can
          still read amber after a save: it also checks that every
          membership type requiring a subscription based on age tier has a
          tier that actually requires one, and that flag is set on Admin
          &rarr; Membership Types, not here. Saving does not tick this step
          off — use &ldquo;Mark this step done&rdquo; above when you are
          happy with it.
        </p>
      </div>
      <AgeTierSection />
    </section>
  );
}

