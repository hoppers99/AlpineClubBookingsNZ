import { LodgesSection } from "./lodges-section";

/**
 * `/admin/lodges` — the shell around {@link LodgesSection} (epic #213, child
 * C19, #250).
 *
 * The editor itself used to BE this file. C19 lifted it into a zero-prop
 * section so the setup wizard can mount the same list, rename form, add-a-lodge
 * and activation controls inline on its `lodges` step, which until now offered
 * an operator nothing but two links out (UAT R2-7). This is the shape
 * `/admin/modules` already uses for `ModulesSection` and
 * `/admin/appearance/identity` for `ClubIdentityPanel`: the page owns the
 * screen's heading and the section owns everything with state.
 *
 * The shell needs no `"use client"` of its own — every stateful thing on this
 * screen, the view-only banner included, is inside the section, which declares
 * the client boundary itself. "Add lodge" went with it rather than staying
 * beside a heading the section no longer owns, so it now opens the section
 * instead of sharing this title's row.
 */
export default function AdminLodgesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Lodges</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Manage the club&apos;s lodge properties. Member-facing screens only
          change once a second active lodge exists.
        </p>
      </div>

      <LodgesSection />
    </div>
  );
}
