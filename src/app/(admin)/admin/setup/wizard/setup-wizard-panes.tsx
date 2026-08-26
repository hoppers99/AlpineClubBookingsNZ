"use client";

import type { ComponentType } from "react";
import { useSession } from "next-auth/react";
import { ClubIdentityPanel } from "@/components/admin/club-identity-panel";
import { ClubTimeZonePanel } from "@/components/admin/club-time-zone-panel";
import { isFullAdmin } from "@/lib/access-roles";
import type { SetupStepId } from "@/lib/setup-step-registry";

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
 * club identity. A Content Officer without Support sees an editable form above
 * dead progress buttons; a Support Officer without Content sees the reverse.
 * Both are true, and both routes enforce their own answer by path and method,
 * so there is no confused deputy here — only two honest 403s if a client-side
 * gate is ever wrong.
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
 * Step id -> the editor the wizard mounts beneath its frame, or `null` with the
 * reason there is none.
 *
 * EXHAUSTIVE BY TYPE. A step added to `SETUP_STEP_DEFINITIONS` fails the
 * typecheck here until somebody writes one of the two answers down.
 */
export const SETUP_STEP_PANES: Record<SetupStepId, ComponentType | null> = {
  // --- Foundation ---
  "club-config": ClubIdentityWizardPane,
  "club-time-zone": ClubTimeZoneWizardPane,
  // Declared by the deployment, not editable from any admin screen: the
  // environment page reports what `APP_ENVIRONMENT_ROLE` says and offers no
  // control that could change it.
  "environment-role": null,
  // Reports the running process's own configuration. There is nothing on this
  // screen that could edit it — the fix is a deployment change and a restart.
  "runtime-env": null,
  // The secret's strength is a property of `AUTH_SECRET` in the environment.
  // An admin form that set it would be a secret typed into a browser.
  "auth-secret-strength": null,
  // The member editor is a per-record admin surface, not a settings section:
  // it needs a chosen member before it can render anything, so there is no
  // zero-prop section to embed. `/admin/members` stays the link out.
  "seed-admin": null,
  // C13 (#239) embeds the module toggles here — the moment mockup 2 promised,
  // where switching a module on redraws the rail beside it. Until then the
  // check carries no `href` and no `links` either, so this step is the one
  // that most needs a pane.
  "feature-flags": null,
  // The club's buildings are a LIST, and each one is set up through its own
  // multi-page per-lodge flow (C6, #221). The step already renders one link
  // per lodge; embedding would mean embedding a whole flow, not a section.
  lodges: null,

  // --- Booking rules ---
  // Deferred to the D16 backlog, and larger than the two proved here:
  // `/admin/booking-policies` is several independent staged sections rather
  // than one, so which of them the step embeds is its own decision.
  "booking-policies": null,
  // Backlog, same round. `/admin/setup/cancellation` is itself one of the
  // legacy setup drill-downs C8's switch hides, so the shape of its section
  // has to settle before a pane can point at it.
  "membership-cancellation": null,
  // Backlog (D16 names age tiers explicitly). Wait for the C13 re-walk.
  "age-tiers": null,
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
  // One toggle on the modules section — so C13 decides it, alongside
  // `feature-flags`, rather than growing a second pane for the same section.
  "address-autocomplete": null,
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
 */
export function SetupWizardStepPane({ stepId }: { stepId: SetupStepId }) {
  const Pane = SETUP_STEP_PANES[stepId];
  if (!Pane) return null;
  return (
    <div data-testid="setup-wizard-step-pane" data-step-id={stepId}>
      <Pane />
    </div>
  );
}
