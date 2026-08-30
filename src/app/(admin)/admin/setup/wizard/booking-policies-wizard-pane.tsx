"use client";

import { DefaultCancellationPolicySection } from "@/components/admin/booking-policies/default-cancellation-policy-section";
import { GroupDiscountSection } from "@/components/admin/booking-policies/group-discount-section";

/**
 * The default cancellation policy and the group discount sections, in the
 * wizard (`booking-policies`).
 *
 * D16 deferred this step to backlog: "`/admin/booking-policies` is several
 * independent staged sections rather than one, so which of them the step
 * embeds is its own decision." C17 (#248, dossier §B.3) makes that decision.
 * The hub (`/admin/booking-policies/page.tsx`) links to SIX independent
 * sections, but `buildBookingPolicyCheck` in `setup-readiness.ts` reads only
 * three facts — `cancellationPolicyCount`, `bookingDefaultsConfigured` and
 * `groupDiscountConfigured` — and all three are written by exactly two of the
 * six: {@link DefaultCancellationPolicySection} (the cancellation rules, and —
 * on its CLUB-WIDE save only — `bookingDefaults`, confirmed by grep that
 * `tx.bookingDefaults.upsert` in
 * `api/admin/booking-policies/cancellation/route.ts` is the ONLY writer of
 * that table; a lodge-override save never reaches it) and
 * {@link GroupDiscountSection}. The other four — date-specific periods,
 * minimum stay, adult-member hosting, public booking requests — change
 * nothing the check reads. Embedding them would be an editor whose Save
 * visibly moves nothing (the R2-2 shape this design avoids), so they stay
 * behind the step's existing `href` to the hub.
 *
 * **Both sections keep their OWN banner — the sanctioned stacked-sections
 * case**, not a gap to fix: `docs/ARCHITECTURE.md` -> "Admin/member layer",
 * "Once per section, NOT once per screen" names `/admin/security` and
 * `/admin/booking-requests` as existing pages where several banner-bearing
 * sections sit side by side, each rendering its own. This wrapper renders NO
 * banner of its own — nothing here composes a third sentence, and the
 * `view-only-banner-contract.test.ts` published census (`bannerComponents`)
 * is untouched by this file.
 *
 * **The area gate composes.** `SETUP_STEP_PERMISSION_AREA["booking-policies"]`
 * is `"bookings"`, and both sections gate their own read/write on
 * `useAdminAreaEditAccess("bookings")` — the SAME area — so
 * `canViewSetupStepPane`'s mount gate and each section's own gate can never
 * disagree about which permission this screen is asking for.
 *
 * The heading sits OUTSIDE both sections and renders unconditionally, for the
 * mount-order reason spelled out on `ClubIdentityWizardPane`.
 */
export function BookingPoliciesWizardPane() {
  return (
    <section className="space-y-3 rounded-md border bg-card p-5">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground">
          Booking policies
        </h3>
        <p className="text-sm text-muted-foreground">
          These two sections are what this step&apos;s checklist reads: the
          default cancellation policy (its refund rules, the non-member hold,
          and the cross-lodge waitlist order) and the group discount. Minimum
          night stay, date-specific cancellation periods, adult-member
          hosting, and public booking requests live on their own screens —
          use &ldquo;Open the settings for this step&rdquo; above to reach
          them. Saving here does not tick the step off — use &ldquo;Mark this
          step done&rdquo; above when you are happy with it.
        </p>
      </div>
      <DefaultCancellationPolicySection />
      <GroupDiscountSection />
    </section>
  );
}

