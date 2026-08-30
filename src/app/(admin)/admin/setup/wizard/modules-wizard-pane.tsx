"use client";

import { ModulesSection } from "@/app/(admin)/admin/modules/modules-section";

/**
 * The module toggles, in the wizard (`feature-flags` AND `address-autocomplete`).
 *
 * **This is the moment mockup 2 was drawn for** (D5, C13 #239). Every other pane
 * edits facts a readiness check READS; this one edits which steps the journey
 * HAS. `setup-step-registry.ts` derives applicability from the module flags, so
 * ticking Xero integration adds `xero-operational` and `xero-mappings` to the
 * rail, and the denominator D7's percentage divides by, without the operator
 * leaving the screen. `ModulesSection` emits
 * `emitSetupReadinessInputChanged()` after a successful save and the shell
 * re-reads the whole journey; nothing here has to know that.
 *
 * **ONE component for TWO steps, deliberately.** `address-autocomplete` is not a
 * pane of its own — it is one checkbox on this very section, so pointing its
 * entry at a second component would be two copies of the same editor differing
 * only in a heading. It also makes this the first registry entry where two steps
 * share a component, which is the case `SetupWizardStepPane`'s `key={stepId}`
 * was written for and could not be tested against until now: walking between the
 * two steps must START THE SECTION OVER rather than reconcile it as the same
 * element and carry an unsaved draft across a navigation the operator believes
 * discarded it.
 *
 * The heading sits OUTSIDE the section and renders unconditionally, for the
 * mount-order reason spelled out on `ClubIdentityWizardPane` — and the section
 * carries no heading of its own precisely so each host can supply the right
 * one. `/admin/modules` gives it the screen's `h1`; here it is an `h3` under the
 * wizard's own.
 *
 * A `<section>` wrapper with a border, like the club-identity pane and unlike
 * the time-zone one: `ModulesSection` renders a banner, a toolbar and a grid of
 * bordered cards, but no frame around the lot.
 */
export function ModulesWizardPane() {
  return (
    <section className="space-y-3 rounded-md border bg-card p-5">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground">Modules</h3>
        <p className="text-sm text-muted-foreground">
          The same editor as Admin &rarr; Modules. Switching a module on or off
          and saving adds or removes its setup steps here in the rail. Address
          autocomplete is both a checkbox here and its own step in the journey,
          because it needs credentials as well as the switch. Saving does not
          tick this step off — use &ldquo;Mark this step done&rdquo; above when
          you are happy with it.
        </p>
      </div>
      <ModulesSection />
    </section>
  );
}

