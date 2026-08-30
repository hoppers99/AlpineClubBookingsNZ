"use client";

import { SeasonsSection } from "@/app/(admin)/admin/seasons/seasons-section";

/**
 * The season-window editor, in the wizard (`seasons-rates`).
 *
 * `SeasonsSection` is C23's (#261) repeat of the C13/C18/C19 move above: zero
 * props, fetches `/api/admin/seasons` for itself, resolves `bookings` edit
 * access for itself, resolves its own lodge scope, and heads itself with its
 * own view-only banner. `/admin/seasons` mounts exactly the same component
 * under its own `AdminPageHeader`; this pane supplies the subordinate heading
 * in its place, for the mount-order reason spelled out on
 * `ClubIdentityWizardPane`.
 *
 * **EMBEDDED WHOLE, not the "lead with a create affordance, deep grid behind
 * the link" subset the dossier also floated — here is why, weighing the
 * rejected alternative rather than asserting the choice.** `SeasonsSection`'s
 * own docblock (`seasons-section.tsx`) works out what `buildSeasonRateCheck`
 * actually reads: `seasonCount` is a CLUB-WIDE count of `active: true`
 * seasons, and this section can move it down, sideways, or — by reactivating
 * a previously-rated season that is currently dormant — back up; only
 * CREATING a season (the club's first, or a lodge's first) needs a rate, and
 * rates are set at Fees → Hut Fees, never here (fix round, #261 finding 1
 * corrected this paragraph's earlier "can only ever move it down or sideways"
 * claim, which was wrong: it conflated creating a season with reactivating
 * one). So this pane's save is not quite the "editor whose save never moves
 * the badge" shape `BookingPoliciesWizardPane` (C17, #248) refused to embed —
 * it CAN move the badge, just not out of every blocked state. The difference
 * from that refusal is what sits on the OTHER side of it regardless:
 * booking-policies
 * had SIX independently owned editors on unrelated tabs, four of which touch
 * nothing the check reads at all, so excluding them lost nothing an operator
 * standing on that step could otherwise do. Seasons-rates has exactly ONE
 * section, and it already leads with the create-elsewhere affordance —
 * `SeasonsSection`'s own `Alert`, unchanged by this extraction, is the FIRST
 * thing it renders, pointing at Fees → Hut Fees before the lodge picker or the
 * list. A pane that mounted nothing but a second copy of that same link would
 * add no capability an operator does not already have from the step frame's
 * own "Open the settings for this step" button, which `href: "/admin/seasons"`
 * already supplies for every step, seasons-rates included. What embedding the
 * whole section adds INSTEAD is real, bookings-area work germane to the step's
 * own subject — fixing a window's wrong dates, retiring a season that should
 * no longer take bookings, deleting a duplicate — none of which is orthogonal
 * to "seasons and rates" the way minimum-night-stay or adult-member hosting
 * were to "booking policies". On pane height: for the dominant wizard
 * scenario — a club with no seasons yet — this section renders the `Alert`,
 * the lodge picker and one empty-state card, which is short, not tall; the
 * dossier's height concern only bites a returning club with many seasons
 * already saved for the lodge it has selected, and that list is scrollable
 * inside the wizard the same way it is on `/admin/seasons` today.
 *
 * The orientation paragraph carries the same caveat `AgeTierWizardPane` states
 * for its own partially-covered check: a perfect pass through this pane —
 * every window's dates right, nothing stale left active — can still leave the
 * step blocked or amber, because the facts that clear THOSE verdicts are set
 * at Fees → Hut Fees, not here.
 *
 * **Club-wide readiness figures beside a per-lodge editor — DISCLOSED, not
 * changed** (fix round, #261 finding 2). `buildSeasonRateCheck`'s three facts
 * are all club-wide (see `SeasonsSection`'s own docblock), while the section
 * below is scoped to whichever lodge its picker currently names, and the
 * wizard rail hands it no `?lodgeId=` — so a two-lodge club can land on a
 * lodge that is not the one holding the season the step's own figures
 * counted, and read "1 season configured." directly above "No seasons
 * configured yet." Making the check lodge-aware is a separate decision with
 * its own trade-offs, not this pane's to make; the fix is the orientation
 * paragraph below saying the two numbers are different SCOPES, not a
 * contradiction. Full reasoning:
 * `docs/multi-lodge/lodge-scoping-contract.md` -> "Setup Wizard: Club-Wide
 * Readiness Beside A Per-Lodge Editor".
 */
export function SeasonsRatesWizardPane() {
  return (
    <section className="space-y-3 rounded-md border bg-card p-5">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground">
          Seasons and rates
        </h3>
        <p className="text-sm text-muted-foreground">
          The same editor as Admin &rarr; Seasons: each lodge&apos;s season
          windows (name, type, dates, and active state), one lodge at a time,
          picked below. The checklist above is club-wide across every lodge,
          so it can read differently from what this pane shows for the lodge
          you have selected — that is two scopes, not a contradiction.
          Reactivating a season that already has rates can clear this
          step&apos;s blocked state on its own; creating a brand-new season,
          and setting its nightly rates, both still happen at Admin &rarr;
          Fees &rarr; Hut Fees, which this section links to. Saving here does
          not tick the step off — use &ldquo;Mark this step done&rdquo; above
          when you are happy with it.
        </p>
      </div>
      <SeasonsSection />
    </section>
  );
}

