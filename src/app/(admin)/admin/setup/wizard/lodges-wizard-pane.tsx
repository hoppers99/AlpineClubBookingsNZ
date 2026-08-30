"use client";

import { LodgesSection } from "@/app/(admin)/admin/lodges/lodges-section";

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
export function LodgesWizardPane() {
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

