"use client";

import type { ComponentType } from "react";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import type { SetupStepId } from "@/lib/setup-step-registry";
import { canViewSetupStepPane } from "@/lib/setup-wizard-step-tables";
import { AgeTierWizardPane } from "./age-tier-wizard-pane";
import { BookingPoliciesWizardPane } from "./booking-policies-wizard-pane";
import { ClubIdentityWizardPane } from "./club-identity-wizard-pane";
import { ClubTimeZoneWizardPane } from "./club-time-zone-wizard-pane";
import { LodgesWizardPane } from "./lodges-wizard-pane";
import { MembershipCancellationWizardPane } from "./membership-cancellation-wizard-pane";
import { ModulesWizardPane } from "./modules-wizard-pane";
import { SeasonsRatesWizardPane } from "./seasons-rates-wizard-pane";
import { SetupWizardFirstAdminPane } from "./setup-wizard-first-admin-pane";

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
 * (both in `setup-wizard-step-tables.ts`) are the same construction for the same
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
  // `setup-wizard-step-tables.ts` for why that also makes this entry's
  // `membership` area mechanical rather than hand-set.
  "membership-cancellation": MembershipCancellationWizardPane,
  // C18 (#249): the age-tier boundary editor, C13's move repeated. See
  // `AgeTierWizardPane` for the pane-copy caveat this step needed that
  // `feature-flags` and `club-config` did not.
  "age-tiers": AgeTierWizardPane,
  // Backlog (D16 names seasons explicitly). Wait for the C13 re-walk.
  // C23 (#261): the season-window editor, the C13/C18/C19 move repeated. See
  // `SeasonsRatesWizardPane` for why this embeds the whole section rather
  // than the create-affordance-plus-summary subset the issue also floated.
  "seasons-rates": SeasonsRatesWizardPane,

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
 * `setup-wizard-step-tables.ts` for the full reasoning. The step frame's existing
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
