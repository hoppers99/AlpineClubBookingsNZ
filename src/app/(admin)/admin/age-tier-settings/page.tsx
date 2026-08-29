import { AdminPageHeader } from "@/components/admin/admin-page-header";
import { AgeTierSection } from "./age-tier-section";

/**
 * `/admin/age-tier-settings` — the shell around {@link AgeTierSection} (epic
 * #213, child C18, #249).
 *
 * The editor itself used to BE this file. C18 lifted it into a zero-prop
 * section, the same move C13 (#239) made for `ModulesSection`, so the setup
 * wizard can mount the same boundary editor inline on its `age-tiers` step.
 * The page keeps the screen's heading and padding; the section owns
 * everything with state, banner included.
 *
 * The shell needs no `"use client"` of its own: every stateful thing on this
 * screen is inside the section, which declares the client boundary itself.
 */
export default function AgeTierSettingsPage() {
  return (
    <div className="p-6">
      <div className="space-y-6">
        <AdminPageHeader
          title="Age Group Settings"
          description={
            <>
              Configure the age boundaries for each membership tier. The highest
              tier has no upper limit. MaxAge for each tier is automatically set to
              the next tier&apos;s MinAge minus 1.
            </>
          }
        />

        <AgeTierSection />
      </div>
    </div>
  );
}
