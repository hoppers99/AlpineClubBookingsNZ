"use client"

import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react"
import Link from "next/link"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { FieldHint, useFieldHint } from "@/components/ui/field-hint"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Alert } from "@/components/ui/alert"
import { AdminViewOnlySectionBanner, ViewOnlyActionButton } from "@/components/admin/view-only-action"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import { emitSetupReadinessInputChanged } from "@/lib/setup-readiness-events"
import { formatNZDate } from "@/lib/nzst-date"
import {
  LodgeSelect,
  initialLodgeIdFromLocation,
  useLodgeOptions,
} from "@/components/lodge-select"
import { LodgeScopeStatusNotice } from "@/components/admin/lodge-options-status"
import { dateOnlyFromIsoString } from "@/lib/date-only";
import { deriveSettledLodgeOptionScope } from "@/lib/lodge-option-scope"

// Season WINDOWS only (#1933, E7): name, type, dates, and active state per
// lodge. Nightly rates moved to the consolidated Fees console (Fees → Hut Fees)
// — editing a window here PUTs without `membershipTypeRates`, so the season's
// rates are left untouched. Creating a season (which requires at least one rate)
// also lives in Fees → Hut Fees, so this page edits existing windows only.

interface Season {
  id: string
  name: string
  type: "WINTER" | "SUMMER"
  startDate: string
  endDate: string
  active: boolean
}

/**
 * The season-window editor, as an EMBEDDABLE SECTION (epic #213, child C23,
 * #261).
 *
 * ## Why this is a section and not a page any more
 *
 * `/admin/seasons/page.tsx` was the whole editor — it fetched for itself,
 * resolved `bookings` edit access for itself, resolved its own lodge scope and
 * headed itself with its own view-only banner. That is the same page-is-
 * component shape C13 (#239), C18 (#249) and C19 (#250) lifted their sections
 * out of, so this repeats that move rather than inventing a new one: the page
 * keeps the screen's `AdminPageHeader`, and this section owns everything with
 * state — lodge scope, form, list, and the banner — the same split
 * `/admin/modules`, `/admin/age-tier-settings` and `/admin/lodges` settled on.
 *
 * ## Zero props, and NO HEADING OF ITS OWN
 *
 * Both hosts supply the heading: `/admin/seasons` keeps its `AdminPageHeader`,
 * and the wizard's `seasons-rates` step supplies its own subordinate heading
 * below the wizard's `h1`. Handing this section a heading of its own would
 * leave the wizard drawing two.
 *
 * ## The view-only banner stays HERE
 *
 * `describeReason={false}` on every `ViewOnlyActionButton` below is a STATIC
 * opt-out (`view-only-banner-contract.test.ts`), which requires the banner it
 * explains to live in the SAME file — so the two move together or not at all,
 * exactly as `ModulesSection` and `AgeTierSection` document for their own
 * controls.
 *
 * ## Lodge scope: CONFIGURATION, and the pin this section already carries
 *
 * `useLodgeOptions("configuration")` is unchanged by this extraction — it was
 * already the right scope before C23 moved this file, per the same rule C6
 * (#221) and C19 (#250) established: a screen that configures a lodge's own
 * facts (its seasons, here) must be able to name a CLOSED lodge too, not just
 * the open ones a booking-facing picker would offer. Switching to any other
 * `useLodgeOptions` scope would silently drop closed lodges from the picker,
 * which is exactly the regression C19's own docblock warns against.
 *
 * The wrong-lodge defect class C6 fixed (a normaliser that silently
 * auto-selects a lodge the operator never named) is why every mutation below
 * still gates on `lodgeScopeReady` and re-checks `activeScopeRef.current`
 * before applying its result — unchanged from the pre-extraction page, and
 * pinned by `seasons-section.test.tsx` -> "lodge scope pin". Mounted in the
 * wizard this section behaves no differently: it still refuses to fetch,
 * save, delete or toggle against a lodge nobody chose, whether the mount is
 * `/admin/seasons` or the `seasons-rates` step pane.
 *
 * ## Saving announces itself, but cannot make the check go green alone
 *
 * `buildSeasonRateCheck` (`setup-readiness.ts`) reads three club-wide facts:
 * `seasonCount` (a GLOBAL count of `active: true` seasons, not scoped to one
 * lodge — `setup-readiness-db.ts`), `membershipTypeRateGaps` and
 * `publicHutFeeSingleColumnSeasons`. This section can move the first of the
 * three — toggling a window's `active` flag, editing its dates so it falls out
 * of the active/future window, or deleting it all change `seasonCount` — so
 * `emitSetupReadinessInputChanged()` follows every successful save, toggle and
 * delete, the same announcement `ModulesSection`, `AgeTierSection` and
 * `LodgesSection` make after their own mutations.
 *
 * **Creating a season needs a rate, but REACTIVATING one does not — so this
 * is not a one-way ratchet** (fix round, #261 finding 1). Creating a season
 * requires at least one rate (the `POST` route's own contract), and rates are
 * set at Fees → Hut Fees, not here — this section's own `Alert`, unchanged
 * from the pre-extraction page, says so. But `GET /api/admin/seasons` returns
 * every season regardless of `active` (no filter), and the `PUT` route above
 * accepts `{active: true}` alone with no rate precondition — so a
 * previously-rated season that is currently dormant (the window ended, an
 * off-season closure) still lists here with an Activate control, and pressing
 * it moves `seasonCount` from 0 straight to 1 without a trip to Fees. What
 * this section can never do is CREATE the club's first season, or a lodge's
 * first, which is the only path that still needs a rate. So the step's
 * PRIMARY blocking verdict (`seasonCount === 0` -> `"blocked"`) CAN be
 * resolved from inside this section when a reactivatable season exists, and
 * only from Fees when none does; its warning verdicts (rate gaps,
 * single-column public seasons) are never resolved here either way.
 * `SeasonsRatesWizardPane` in `setup-wizard-panes.tsx` records why that
 * asymmetry decided the wizard pane's shape.
 */
export function SeasonsSection() {
  const [seasons, setSeasons] = useState<Season[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [editingId, setEditingId] = useState<string | null>(null)
  const canEdit = useAdminAreaEditAccess("bookings")
  const {
    lodges,
    loading: lodgesLoading,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
    reload: reloadLodgeOptions,
  } = useLodgeOptions("configuration")
  const [lodgeId, setLodgeId] = useState<string | null>(initialLodgeIdFromLocation)
  /*
    #2701: a FAILED lodge list is not "a club with no lodges", but until now the
    two were the same empty array here. LodgeSelect renders nothing below two
    options (ADR-002) and normalises the selection to null, and an unscoped
    seasons read is not this lodge's — so the windows listed below, and the
    dates an admin would then edit on them, could belong to a lodge nobody chose
    and nothing on screen names. While that is true this page does no
    lodge-scoped work at all.

    A `?lodgeId=` hub link is retained through failure/retry, but remains inert
    until a successful lodge response validates that id.
  */
  const lodgeScope = deriveSettledLodgeOptionScope({
    lodges,
    selectedLodgeId: lodgeId,
    loading: lodgesLoading,
    failed: lodgeOptionsFailed,
    forbidden: lodgeOptionsForbidden,
  })
  const scopedLodgeId = lodgeScope.kind === "lodge" ? lodgeScope.lodgeId : null
  const activeScopeRef = useRef<string | null>(scopedLodgeId)
  /*
    #2887: ownership follows the COMMIT, not the render, and this must stay a
    LAYOUT effect - a passive one is flushed after paint, leaving a window in
    which a late lodge-A response still reads A as current. Full reasoning and
    both mutation proofs live in one place:
    `src/lib/__tests__/lodge-scope-committed-ownership.test.tsx`.
  */
  useLayoutEffect(() => {
    activeScopeRef.current = scopedLodgeId
  }, [scopedLodgeId])
  const lodgeScopeReady = scopedLodgeId !== null

  // Form state (window fields only)
  const [name, setName] = useState("")
  // #2257 — the example lives UNDER the field, not inside it as grey pseudo-content.
  const nameHint = useFieldHint()
  const [type, setType] = useState<"WINTER" | "SUMMER">("WINTER")
  const [startDate, setStartDate] = useState("")
  const [endDate, setEndDate] = useState("")
  const [active, setActive] = useState(true)
  const [saving, setSaving] = useState(false)

  const fetchSeasons = useCallback(async (signal?: AbortSignal) => {
    // #2701: no lodge, no read. Clear what the pre-failure unscoped request
    // put on screen too, and drop any half-open edit: a window opened from a
    // row we can no longer vouch for must not stay editable.
    if (!scopedLodgeId) {
      setSeasons([])
      setEditingId(null)
      setError("")
      setLoading(false)
      return
    }
    try {
      const res = await fetch(
        `/api/admin/seasons?lodgeId=${encodeURIComponent(scopedLodgeId)}`,
        { signal },
      )
      if (!res.ok) throw new Error("Failed to fetch seasons")
      const data = await res.json()
      setSeasons(data)
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setLoading(false)
    }
  }, [scopedLodgeId])

  useEffect(() => {
    const controller = new AbortController()
    fetchSeasons(controller.signal)
    return () => controller.abort()
  }, [fetchSeasons])

  function resetForm() {
    setName("")
    setType("WINTER")
    setStartDate("")
    setEndDate("")
    setActive(true)
    setEditingId(null)
    setError("")
  }

  function handleLodgeChange(nextLodgeId: string | null) {
    activeScopeRef.current = nextLodgeId
    setLodgeId(nextLodgeId)
    setSeasons([])
    setLoading(true)
    resetForm()
  }

  function startEdit(season: Season) {
    if (!lodgeScopeReady) return
    setEditingId(season.id)
    setName(season.name)
    setType(season.type)
    setStartDate(dateOnlyFromIsoString(season.startDate))
    setEndDate(dateOnlyFromIsoString(season.endDate))
    setActive(season.active)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!editingId || !lodgeScopeReady) return
    const requestedScope = scopedLodgeId
    setSaving(true)
    setError("")

    // Window-only PUT: omit membershipTypeRates so the [id] route leaves the
    // season's existing rates untouched (see the route's `if (membershipTypeRates)`
    // guard). Rates are edited in Fees → Hut Fees.
    const payload = { name, type, startDate, endDate, active }

    try {
      const res = await fetch(`/api/admin/seasons/${editingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to save season")
      }
      if (activeScopeRef.current !== requestedScope) return
      // The saved window's dates and active flag are facts the seasons-rates
      // check reads (see this file's docblock).
      emitSetupReadinessInputChanged()
      resetForm()
      fetchSeasons()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: string) {
    if (!lodgeScopeReady) return
    const requestedScope = scopedLodgeId
    if (!confirm("Are you sure you want to delete this season?")) return
    try {
      const res = await fetch(`/api/admin/seasons/${id}`, { method: "DELETE" })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to delete")
      }
      if (activeScopeRef.current !== requestedScope) return
      // A deleted season is one the seasons-rates check no longer counts.
      emitSetupReadinessInputChanged()
      fetchSeasons()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  async function handleToggleActive(season: Season) {
    if (!lodgeScopeReady) return
    const requestedScope = scopedLodgeId
    try {
      const res = await fetch(`/api/admin/seasons/${season.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !season.active }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || "Failed to update")
      }
      if (activeScopeRef.current !== requestedScope) return
      // Toggling `active` is the one control that can move `seasonCount`
      // straight up or down without an edit form.
      emitSetupReadinessInputChanged()
      fetchSeasons()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the page —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted (the component renders it whatever `canEdit` is) so the live region
    is registered in the accessibility tree before its content appears; a region
    injected already-populated is silently dropped by some screen-reader/browser
    pairings. It sits OUTSIDE the `space-y-6` stack so the empty wrapper an
    edit-capable admin gets costs no layout — the spacing lives on the inner box.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Bookings view access can inspect season windows. Bookings edit access is required to change them.
    </AdminViewOnlySectionBanner>
  )

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <Alert>
        <span>
          To add a season or change its nightly rates, use{" "}
          <Link href="/admin/fees" className="underline font-medium">Fees → Hut Fees</Link>.
          This page edits an existing season&apos;s window (dates, name, type, active) and leaves its rates untouched.
        </span>
      </Alert>

      {/* #2701: say the lodge list failed, above the lodge-scoped windows it
          silently replaced with another lodge's. */}
      <LodgeScopeStatusNotice
        scope={lodgeScope}
        onRetry={reloadLodgeOptions}
        what="season windows"
      />

      <div className="max-w-xs">
        <LodgeSelect lodges={lodges} value={lodgeId} onChange={handleLodgeChange} loading={lodgesLoading}
            // #2701: an empty list from a FAILED request is not evidence the
            // caller's lodge is gone, so the ADR-002 normaliser must not wipe a
            // ?lodgeId= hub link (ADR-003) while the outage lasts.
            deferDefaultSelection={lodgeOptionsFailed || lodgeOptionsForbidden}
          />
      </div>

      {error && (
        <div role="alert" className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">
          {error}
        </div>
      )}

      {lodgeScopeReady && editingId && canEdit && (
        <Card>
          <CardHeader>
            <CardTitle>Edit Season Window</CardTitle>
            <CardDescription>Update the season period, name, type, and active state. Rates are unchanged.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Season Name</Label>
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required {...nameHint.fieldProps} />
                  <FieldHint {...nameHint.hintProps}>Example: Winter 2026</FieldHint>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="type">Type</Label>
                  <select
                    id="type"
                    value={type}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setType(e.target.value as "WINTER" | "SUMMER")}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                  >
                    <option value="WINTER">Winter</option>
                    <option value="SUMMER">Summer</option>
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="startDate">Start Date</Label>
                  <Input id="startDate" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="endDate">End Date</Label>
                  <Input id="endDate" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <input type="checkbox" id="active" checked={active} onChange={(e) => setActive(e.target.checked)} className="rounded border-input" />
                <Label htmlFor="active">Active</Label>
              </div>

              <div className="flex space-x-3">
                {/* #2701: belt and braces — clearing `editingId` already closes
                    this card when the lodge list fails, so this only covers a
                    failure that lands mid-edit. */}
                <Button type="submit" disabled={saving || !lodgeScopeReady}>
                  {saving ? "Saving..." : "Update Season"}
                </Button>
                <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {!lodgeScopeReady ? null : loading ? (
        <div className="text-center py-8">Loading seasons...</div>
      ) : seasons.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            No seasons configured yet. Add one in Fees → Hut Fees.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {seasons.map((season) => (
            <Card key={season.id}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <CardTitle className="text-xl">{season.name}</CardTitle>
                    <Badge variant={season.type === "WINTER" ? "default" : "secondary"}>{season.type}</Badge>
                    <Badge variant={season.active ? "default" : "outline"}>{season.active ? "Active" : "Inactive"}</Badge>
                  </div>
                  {canEdit && (
                    <div className="flex space-x-2">
                      <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => handleToggleActive(season)}>
                        {season.active ? "Deactivate" : "Activate"}
                      </ViewOnlyActionButton>
                      <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => startEdit(season)}>
                        Edit window
                      </ViewOnlyActionButton>
                      <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="destructive" size="sm" onClick={() => handleDelete(season.id)}>
                        Delete
                      </ViewOnlyActionButton>
                    </div>
                  )}
                </div>
                <CardDescription>
                  {formatNZDate(new Date(season.startDate))} &mdash;{" "}
                  {formatNZDate(new Date(season.endDate))}
                </CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}
      </div>
    </div>
  )
}
