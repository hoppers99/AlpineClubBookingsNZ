"use client";

import { ClubIdentityPanel } from "@/components/admin/club-identity-panel";

/**
 * The club-identity editor, in the wizard (`club-config`).
 *
 * `ClubIdentityPanel` is a literal one-line embed — zero props, fetches
 * `/api/admin/club-identity` for itself, resolves `content` edit access for
 * itself, and heads itself with its own view-only banner, hoisted above its own
 * early returns. `/admin/appearance/identity` mounts exactly the same component
 * inside a `<Card>`; this is that page's first card, without the two below it.
 *
 * The heading here sits OUTSIDE the panel and is rendered unconditionally,
 * which is what keeps it clear of the mount-order hazard in
 * `docs/ARCHITECTURE.md`: a heading rendered only in a section's LOADED branch
 * makes React reconcile the live region's first child into it and mount a
 * fresh, already-populated region below. This heading is in a different
 * component and in a branch that never varies, so the panel's own region is
 * registered before its content, exactly as on the settings page.
 */
export function ClubIdentityWizardPane() {
  return (
    <section className="space-y-3 rounded-md border bg-card p-5">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground">Club identity</h3>
        <p className="text-sm text-muted-foreground">
          The same editor as Site Appearance &amp; Content &rarr; Club Identity.
          Saving here does not tick the step off — use &ldquo;Mark this step
          done&rdquo; above when you are happy with it.
        </p>
      </div>
      <ClubIdentityPanel />
    </section>
  );
}

