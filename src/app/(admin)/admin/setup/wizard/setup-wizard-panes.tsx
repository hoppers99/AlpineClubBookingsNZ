"use client";

import type { ComponentType } from "react";
import { useSession } from "next-auth/react";
import { ClubIdentityPanel } from "@/components/admin/club-identity-panel";
import { ClubTimeZonePanel } from "@/components/admin/club-time-zone-panel";
import { ModulesSection } from "@/app/(admin)/admin/modules/modules-section";
import { LodgesSection } from "@/app/(admin)/admin/lodges/lodges-section";
import { SetupWizardFirstAdminPane } from "./setup-wizard-first-admin-pane";
import { AgeTierSection } from "@/app/(admin)/admin/age-tier-settings/age-tier-section";
import { isFullAdmin } from "@/lib/access-roles";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { canViewSetupStepPane } from "@/lib/setup-wizard-view";
import type { SetupStepId } from "@/lib/setup-step-registry";
import { DefaultCancellationPolicySection } from "@/components/admin/booking-policies/default-cancellation-policy-section";
import { GroupDiscountSection } from "@/components/admin/booking-policies/group-discount-section";
import { MembershipCancellationSettingsPanel } from "@/components/admin/membership-cancellation-settings-panel";

/**
 * The wizard's per-step inline editors (epic #213, child C12; owner decision
 * D16, "hybrid embed, proof first").
 *
 * ## What this fixes
 *
 * Every step pane shipped as readiness detail plus a link out to the real
 * settings page. That was a NARROWING of D8 that was never put to the owner:
 * D8's own exemplar — the per-lodge setup flow — has real fields inline, C7's
 * acceptance criterion and mockup 2 both promised inline editing, and the step
 * frame's docblock quietly reinterpreted "compose the existing editor" as "link
 * to it". D16 restores the recorded design for two steps first, as proof, with
 * a re-test checkpoint after C13 before the rest follow.
 *
 * ## Why a Record here, and not a field on `SetupStepDefinition`
 *
 * `@/lib/setup-step-registry` is imported by `npm run setup:check`, a `tsx`
 * entrypoint with no React and no bundler. A `ComponentType` on a definition
 * would drag the whole admin component tree across that boundary for the sake
 * of a value the CLI can never render. So the mapping lives on the COMPONENT
 * side, keyed by the id union — which costs nothing the definition gave us: an
 * exhaustive `Record<SetupStepId, …>` still fails the typecheck the moment a
 * later child adds a step, so nobody can add one and leave this table silently
 * behind. `SETUP_STEP_PERMISSION_AREA` and `SETUP_STEP_DEFAULTED_EVIDENCE`
 * (both in `setup-wizard-view.ts`) are the same construction for the same
 * reason, and the reason is written out at length on the second of them.
 *
 * **`null` is a decision, not a gap**, so every one carries its sentence. "No
 * pane yet" and "no pane ever" are different answers and the reader is owed
 * which.
 *
 * ## Why the render site is a SIBLING of the step frame, never a child
 *
 * `SetupWizardStepFrame` renders an `AdminViewOnlySectionBanner` of its own, and
 * `ClubIdentityPanel` renders one too. The nesting rule in
 * `view-only-banner-contract.test.ts` ("never nests one banner-bearing component
 * inside another") fails that pair: a view-only admin would meet a view-only
 * sentence twice inside one card, in two `role="status"` regions, both
 * announced. `SetupWizardClient` renders no banner at all, so mounting the pane
 * BESIDE the frame there is the sanctioned shape — `docs/ARCHITECTURE.md` ->
 * "Admin/member layer", "Once per section, NOT once per screen", which says in
 * as many words that the rule is about parent and child and structurally cannot
 * speak about siblings.
 *
 * **Two banners on this screen is correct, and it is not duplication.** They
 * state different permissions with different answers. The frame's banner is
 * about changing a STEP'S PROGRESS, which is one API for the whole journey and
 * is enforced at `support: edit`. The pane's banner is about doing the step's
 * actual WORK, which is governed by that step's own area — `content` for the
 * club identity. A club-defined role holding `support: view` plus
 * `content: edit` — combining both is how a club would build this, since a
 * Content Officer alone never reaches `/admin/setup/wizard` at all
 * (`support: view` gates admission, and `ADMIN_CONTENT` carries none of it) —
 * sees a dead frame above an editable pane; a Support Officer who also holds
 * `content: view` but not `edit` sees the reverse: a live frame above a pane
 * whose fields render but whose Save stays disabled. Both are true, and both
 * routes enforce their own answer by path and method, so there is no confused
 * deputy here — only two honest 403s if a client-side gate is ever wrong.
 *
 * ## What a pane does NOT do
 *
 * Saving in a pane does not mark the step done. "Mark this step done" stays the
 * one explicit confirmation gesture, which is exactly what C11 (#237) split out
 * of derived readiness: a green badge is a statement that a PERSON agreed, and
 * a form submission is not that statement. What a save does do is change facts
 * the readiness check reads, so the panes announce it through
 * `emitSetupReadinessInputChanged` and the shell re-reads the journey. See that
 * module for why the announcement points that way round.
 */

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
function ClubIdentityWizardPane() {
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

/**
 * The club time-zone editor, in the wizard (`club-time-zone`).
 *
 * **This one is not a bare embed, and must not become one.**
 * `ClubTimeZonePanel` is Full-Admin-only — `/api/admin/club-time-zone` guards
 * both verbs with `requireAdmin({ permission: false })` — and it deliberately
 * renders NO view-only banner, because it has no view tier and no edit tier for
 * one to describe (its own docblock explains this at length, and asks not to be
 * "fixed"). Its page shell therefore carries the gate: `/admin/club-time`
 * tests `isFullAdmin` and swaps in a short "full administrators only" panel.
 *
 * This replicates that shell test, including the `session &&` guard. While the
 * session is still resolving there are no access roles to read, and answering
 * "not a full admin" from an empty array would flash the refusal at the very
 * administrators who are allowed in. The panel is shown in that window; the
 * server is the real gate either way, and this check exists only so the screen
 * does not offer an action it already knows will be refused.
 *
 * No wrapping card: unlike `ClubIdentityPanel`, this panel renders its own
 * `rounded-md border bg-card`, and nesting a second one around it would put two
 * borders on one editor.
 */
function ClubTimeZoneWizardPane() {
  const { data: session } = useSession();
  const fullAdmin = isFullAdmin({
    accessRoles: session?.user?.accessRoles ?? [],
  });

  if (session && !fullAdmin) {
    return (
      <div className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
        The club time zone is available to full administrators only.
      </div>
    );
  }

  return <ClubTimeZonePanel />;
}

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
function ModulesWizardPane() {
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

/**
 * The lodge list, in the wizard (`lodges`).
 *
 * **The step UAT R2-7 was about** (D18, C19 #250). An operator standing here
 * asked "and how do I set up a lodge here???" of a screen that carried the
 * readiness lines, a link to `/admin/lodges` and a link per lodge into its own
 * setup flow — and nothing to actually do. `LodgesSection` is the whole of the
 * old `/admin/lodges` page: the list with each lodge's open/closed state, the
 * rename form, add-a-lodge, and activate/deactivate with its dependency
 * confirm.
 *
 * **The per-lodge six-step flow stays a LINK, and that is the point rather than
 * a shortfall.** `/admin/lodges/[id]/setup` is a guided flow of its own —
 * rooms, lockers, seasons, chores, activation — so embedding it would be a
 * wizard inside a wizard, which is not the shape D16 asked to prove and is the
 * same reason the four provider setups have no pane. It is also the best setup
 * screen the product has, so the honest move is to send the operator to it. The
 * step frame above still lists one link per lodge, and every row in the section
 * carries its own "Configure".
 *
 * **Two banners, and no nesting.** `LodgesSection` heads itself with the
 * lodge-area banner, exactly as `ModulesSection` does, and it must: the section
 * vouches for `OtherLodgesPanel` (`ancestorRendersViewOnlyBanner`), and a vouch
 * is verified against the file the render site sits in. The pane is still a
 * SIBLING of the step frame, never a child — see this module's docblock.
 *
 * The heading sits OUTSIDE the section and renders unconditionally, for the
 * mount-order reason spelled out on `ClubIdentityWizardPane`. The orientation
 * paragraph names the seeded `"<Club> Lodge"` rename the way this file's
 * club-identity copy orients the operator on the club name: R2-7's own second
 * wrinkle was that the seeded lodge name is an unconfirmed installer default
 * with nothing anywhere prompting anybody to change it. The rename is one
 * "Edit" away in the list below, so the paragraph says so.
 */
function LodgesWizardPane() {
  return (
    <section className="space-y-3 rounded-md border bg-card p-5">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground">Lodges</h3>
        <p className="text-sm text-muted-foreground">
          The same editor as Admin &rarr; Lodges. A fresh install is seeded with
          one lodge named after the club — &ldquo;
          <span className="italic">your club&rsquo;s name</span> Lodge&rdquo; —
          so if that is not what the building is called, press Edit beside it and
          give it its real name. Each lodge&rsquo;s rooms, beds, seasons and
          chores are set up in its own guided flow, which the Configure button
          and the links above both open. Saving here does not tick this step off
          — use &ldquo;Mark this step done&rdquo; above when you are happy with
          it.
        </p>
      </div>
      <LodgesSection />
    </section>
  );
}

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
function AgeTierWizardPane() {
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
function BookingPoliciesWizardPane() {
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
 * (`setup-wizard-view.ts` carries the full evidence). That is what keeps the
 * step frame's "That page belongs to Membership" and this panel's own
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
function MembershipCancellationWizardPane() {
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

/**
 * Step id -> the editor the wizard mounts beneath its frame, or `null` with the
 * reason there is none.
 *
 * EXHAUSTIVE BY TYPE. A step added to `SETUP_STEP_DEFINITIONS` fails the
 * typecheck here until somebody writes one of the two answers down — TS2741
 * ("Property '<id>' is missing in type ... but required in type
 * 'Record<SetupStepId, ...>'") when exactly one step is missing an entry, or
 * TS2739 ("Type ... is missing the following properties from type ...: <id>,
 * <id>, ...") when a later change adds several steps at once.
 *
 * **The five ENVIRONMENT-fact entries are VESTIGIAL since D17 (C15 #246) and
 * are kept for type-totality only.** A pane is mounted beside the STEP FRAME,
 * and a fact has no step frame — it is a row on the Server-environment panel —
 * so nothing can reach one of those entries at runtime. Their `null`s stay
 * because the `Record` is total, and `setup-wizard-panes.test.tsx` now fails the
 * build if one ever becomes a component, because that would be dead code wearing
 * the shape of a feature.
 */
export const SETUP_STEP_PANES: Record<SetupStepId, ComponentType | null> = {
  // --- Foundation ---
  "club-config": ClubIdentityWizardPane,
  "club-time-zone": ClubTimeZoneWizardPane,
  // No pane, and since D17 (#246) not "yet" either: this is an environment
  // FACT, so there is no step frame to mount a pane beneath. The earlier note
  // is kept because it stays true of the shape — `/admin/environment` mounts a
  // zero-prop `EnvironmentSafetyPanel` behind the same Full-Admin swap this
  // file replicates for `club-time-zone`, and its safer override genuinely
  // changes the resolved role — so a future decision to embed it would have to
  // reclassify the entry first.
  "environment-role": null,
  // Reports the running process's own configuration. There is nothing on this
  // screen that could edit it — the fix is a deployment change and a restart.
  "runtime-env": null,
  // The secret's strength is a property of `AUTH_SECRET` in the environment.
  // An admin form that set it would be a secret typed into a browser.
  "auth-secret-strength": null,
  // C20 (#251): the ONE pane in this table that is BUILT rather than embedded.
  // The member editor is a per-record admin surface, not a settings section —
  // it needs a chosen member before it can render anything — so there is no
  // zero-prop section to embed and D8's parity rule has nothing to point at.
  // `SetupWizardFirstAdminPane` is therefore the smallest form that can satisfy
  // the step (create only; retiring the seeded account is its own decision),
  // and its own file carries the reasoning — including which column the
  // readiness check counts, which is the trap this step hides.
  // `/admin/members` stays the link out.
  "seed-admin": SetupWizardFirstAdminPane,
  // C13 (#239): the module toggles, and the moment mockup 2 promised — switching
  // a module on redraws the rail beside it. This step had no pane AND no link
  // (its check carries neither `href` nor `links`), so it was the one step the
  // wizard offered no route out of at all.
  "feature-flags": ModulesWizardPane,
  // C19 (#250): the lodge list, its rename form, add-a-lodge and the
  // activate/deactivate control. The club's buildings are a LIST and each one
  // is set up through its own multi-page per-lodge flow (C6, #221) — so the
  // FLOW stays a link, as it always was, and what the pane embeds is the
  // section around it. UAT R2-7 is why: this step offered two kinds of link and
  // nothing to do.
  lodges: LodgesWizardPane,

  "booking-policies": BookingPoliciesWizardPane,
  // C22 (#260): the cancellation-warning/rejoin-copy/Xero-archive editor.
  // The check's `href` now points straight at it, `/admin/membership-cancellation`
  // — see `MembershipCancellationWizardPane` and
  // `SETUP_STEP_PERMISSION_AREA["membership-cancellation"]` in
  // `setup-wizard-view.ts` for why that also makes this entry's `membership`
  // area mechanical rather than hand-set.
  "membership-cancellation": MembershipCancellationWizardPane,
  // C18 (#249): the age-tier boundary editor, C13's move repeated. See
  // `AgeTierWizardPane` for the pane-copy caveat this step needed that
  // `feature-flags` and `club-config` did not.
  "age-tiers": AgeTierWizardPane,
  // Backlog (D16 names seasons explicitly). Wait for the C13 re-walk.
  "seasons-rates": null,

  // --- Website ---
  // Backlog, and D16 splits it in two — colours and fonts are separate
  // decisions on `/admin/site-style` — so this is not one pane at all.
  "site-style": null,

  // --- Operational integrations ---
  // Each of these four is a multi-step credential wizard of its own
  // (`/admin/stripe/setup`, `/admin/xero/setup`, and the health page's
  // provider sections), gated on Full Admin ON TOP of its area. Embedding a
  // wizard inside a wizard is not the shape D16 asked to prove, and each one
  // already carries the provider test the frame composes (C8, #223).
  stripe: null,
  "email-ses": null,
  sentry: null,
  "xero-operational": null,
  // C13 (#239) decided it: RIDES ALONG on the same section. The step is one
  // checkbox on that grid, so a pane of its own would be a second copy of the
  // same editor differing only in a heading — and the wizard would then hold
  // two components that fetch and save the same `/api/admin/modules`. The one
  // asymmetry is deliberate and stated rather than hidden: switching THIS
  // module off from THIS step removes the step the operator is standing on, so
  // the shell's fallback moves them on and its notice says so
  // (`setup-wizard-client.tsx`, which C13 also taught to speak when the
  // operator had made no explicit selection). No other module owns a step at or
  // before `address-autocomplete`'s order, so that is the only self-removal
  // either pane can produce.
  "address-autocomplete": ModulesWizardPane,
  // Not a setting: the check asks whether a live operational Xero connection
  // exists, and the link goes to `/finance` to look at the result.
  "finance-dashboard": null,
  // The Xero mapping editor lives inside `/admin/xero`'s tabbed shell and is
  // reached by anchor, not as a standalone zero-prop section. Backlog.
  "xero-mappings": null,
};

/**
 * The pane for the step the operator is on, or nothing.
 *
 * Rendered by `SetupWizardClient` as a SIBLING of the step frame — see this
 * module's docblock for why it can never be a child of it.
 *
 * **Gated on VIEW access to the step's own area before it mounts at all**
 * (#238 fix round F1). A viewer who lacks even view on
 * `SETUP_STEP_PERMISSION_AREA[stepId]` — the shipped shape for
 * `ADMIN_BOOKINGS`, `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN` on `club-config`,
 * none of which carry `content` — was never offered a route to the real
 * settings page either, so mounting the pane here would only hand them a
 * panel whose own fetch 403s. See `canViewSetupStepPane` in
 * `setup-wizard-view.ts` for the full reasoning. The step frame's existing
 * link-out and copy are unaffected — this only withholds the embedded copy of
 * the editor, exactly as no pane at all behaved before C12.
 */
export function SetupWizardStepPane({
  stepId,
  permissionMatrix,
}: {
  stepId: SetupStepId;
  permissionMatrix: AdminPermissionMatrix;
}) {
  const Pane = SETUP_STEP_PANES[stepId];
  if (!Pane) return null;
  if (!canViewSetupStepPane(permissionMatrix, stepId)) return null;
  return (
    // Keyed by STEP, not by component, so that walking between two steps that
    // share one pane starts the pane over rather than reconciling it as the
    // same element and carrying the previous step's half-typed form across —
    // a staged edit surviving a navigation the operator believes discarded it.
    // EXERCISED SINCE C13 (#239): `feature-flags` and `address-autocomplete`
    // both mount `ModulesWizardPane`, so React would otherwise reconcile the
    // two as one element and keep the unsaved checkbox draft. Pinned in
    // `setup-wizard-panes.test.tsx` -> "two steps sharing one pane" — a test
    // C12 could not write, because until now no two entries named the same
    // component and every move remounted on its own.
    <div
      key={stepId}
      data-testid="setup-wizard-step-pane"
      data-step-id={stepId}
    >
      <Pane />
    </div>
  );
}
