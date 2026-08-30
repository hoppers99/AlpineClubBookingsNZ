import { AdminPageHeader } from "@/components/admin/admin-page-header"
import { SeasonsSection } from "./seasons-section"

/**
 * `/admin/seasons` — the shell around {@link SeasonsSection} (epic #213, child
 * C23, #261).
 *
 * The editor itself used to BE this file. C23 lifted it into a zero-prop
 * section, the same move C13 (#239), C18 (#249) and C19 (#250) made for their
 * own screens, so the setup wizard can mount the same season-window editor
 * inline on its `seasons-rates` step. The page keeps the screen's
 * `AdminPageHeader`; the section owns everything with state.
 *
 * The shell needs no `"use client"` of its own: every stateful thing on this
 * screen is inside the section, which declares the client boundary itself.
 */
export default function SeasonsPage() {
  return (
    <div className="space-y-6">
      <AdminPageHeader
        title="Seasons"
        description="Season windows (name, type, dates, and active state) per lodge. Set nightly rates and add new seasons in Fees → Hut Fees."
      />

      <SeasonsSection />
    </div>
  )
}
