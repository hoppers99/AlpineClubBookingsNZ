"use client"

import { useCallback, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state"
import { ADMIN_FORBIDDEN_SAVE_REASON, AdminViewOnlySectionBanner, ViewOnlyActionButton } from "@/components/admin/view-only-action"
import { PolicyFeedback } from "./policy-feedback"

const ENDPOINT = "/api/admin/booking-requests/settings"

interface BookingRequestSettings {
  showPricingToNonMembers: boolean
  quoteResponseTtlDays: number
  quoteReminderLeadDays: number
  attendeeConfirmationLeadDays: number
  attendeeConfirmationReminderDays: number
}

/**
 * The Indicative Pricing card's own draft (#2162).
 *
 * All five settings live in ONE server-side row behind ONE whole-object PUT, so
 * a single `useSectionEditState` instance for the whole section would match the
 * storage exactly. It cannot be used here, because the hook carries ONE
 * `editing` flag and the three cards do not share an editing mode: the two
 * timing cards are always-editable with a dirty-gated Save (their shape since
 * before #2142, unchanged by this issue), while the canonical pattern this card
 * is being brought onto reveals Save/Cancel behind a per-card Edit. Fusing them
 * would have forced an Edit step onto the two timing cards as a side effect.
 * Joining one of those cards' state instead would have been arbitrary: pricing
 * visibility is a public-facing disclosure, not quote or attendee timing, and
 * it is its own card in the UI.
 *
 * The price of a separate instance is the shared write object, and it is paid
 * the documented way (`AGENTS.md`, `docs/ARCHITECTURE.md`): the save GETs the
 * fresh settings and merges only its own key, exactly as the magic-link and
 * Google cards do against `PUT /api/admin/modules`. That is what keeps this
 * card from writing a sibling card's UNSAVED draft, or its own stale snapshot
 * of one, back over storage.
 */
interface PricingDraft {
  showPricingToNonMembers: boolean
}

/**
 * Seed for the form, and the value a FAILED load leaves in it. It matches what
 * `getBookingRequestSettings` synthesises when no row is stored.
 */
const SETTINGS_FALLBACK: BookingRequestSettings = {
  showPricingToNonMembers: false,
  quoteResponseTtlDays: 14,
  quoteReminderLeadDays: 3,
  attendeeConfirmationLeadDays: 14,
  attendeeConfirmationReminderDays: 3,
}

async function fetchSettings(signal?: AbortSignal): Promise<BookingRequestSettings> {
  const res = await fetch(ENDPOINT, signal ? { signal } : undefined)
  if (!res.ok) throw new Error("Failed to fetch booking request settings")
  return (await res.json()) as BookingRequestSettings
}

/**
 * The section's only write. The route takes the whole settings object, so every
 * card sends all five fields; each caller is responsible for the ones it does
 * not own being the STORED values rather than a stale or uncommitted draft.
 *
 * Throws {@link ForbiddenSaveError} for a 403 so both the hook-driven card and
 * the two hand-rolled ones map it to the same shared copy.
 */
async function putSettings(
  body: BookingRequestSettings,
): Promise<BookingRequestSettings> {
  const res = await fetch(ENDPOINT, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    if (res.status === 403) throw new ForbiddenSaveError()
    const data = await res.json()
    throw new Error(data.error || "Failed to save")
  }
  return (await res.json()) as BookingRequestSettings
}

export function PublicBookingRequestsSection() {
  const [settings, setSettings] = useState<BookingRequestSettings>(SETTINGS_FALLBACK)
  const [ttlDraft, setTtlDraft] = useState("14")
  const [reminderDraft, setReminderDraft] = useState("3")
  const [attendeeLeadDraft, setAttendeeLeadDraft] = useState("14")
  const [attendeeReminderDraft, setAttendeeReminderDraft] = useState("3")
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [success, setSuccess] = useState("")
  // Booking-request settings gate on the bookings area (its write route enforces
  // bookings:edit); a bookings:view admin sees the whole section read-only
  // (#1940). Since #2162 no control in it auto-persists, so the gate is now
  // purely about which affordances are offered, not about a silent 403.
  const canEdit = useAdminAreaEditAccess("bookings")

  const applySettings = useCallback((data: BookingRequestSettings) => {
    setSettings(data)
    setTtlDraft(String(data.quoteResponseTtlDays))
    setReminderDraft(String(data.quoteReminderLeadDays))
    setAttendeeLeadDraft(String(data.attendeeConfirmationLeadDays))
    setAttendeeReminderDraft(String(data.attendeeConfirmationReminderDays))
  }, [])

  /*
    #2162: the Indicative Pricing card. It owns the section's single GET as
    well as its own draft/snapshot pair, so the section still loads once — the
    `load` seeds the two timing cards through `applySettings` on its way past
    and returns only this card's slice.
  */
  const pricing = useSectionEditState<PricingDraft>({
    initial: { showPricingToNonMembers: SETTINGS_FALLBACK.showPricingToNonMembers },
    load: async (signal) => {
      const data = await fetchSettings(signal)
      if (!signal.aborted) applySettings(data)
      return { showPricingToNonMembers: data.showPricingToNonMembers }
    },
    save: async (draft) => {
      // The two timing cards report through the section's own feedback state;
      // clear it here so one card's stale confirmation cannot sit above another
      // card's fresh result.
      setError("")
      setSuccess("")
      // GET-fresh-then-merge over the shared whole-object PUT: write the STORED
      // timing values plus this card's new one, never the snapshot this card
      // happened to load with and never a timing draft the admin has typed but
      // not saved.
      const fresh = await fetchSettings()
      const next = await putSettings({
        ...fresh,
        showPricingToNonMembers: draft.showPricingToNonMembers,
      })
      // Re-seed the SNAPSHOT the timing cards send their unchanged fields from,
      // so a later "Save quote timing" cannot revert the pricing change that
      // just landed. Their text drafts are deliberately left alone: they are the
      // admin's own in-progress input and this save was not theirs.
      setSettings(next)
      return { showPricingToNonMembers: next.showPricingToNonMembers }
    },
    successMessage: "Booking request settings saved",
    // No first-save exception, even though the GET SYNTHESISES defaults when no
    // row is stored (`getBookingRequestSettings`). The exception exists so a
    // form whose defaults are already correct can still commit them; here the
    // whole draft is one boolean, so "unchanged" and "already effectively
    // stored" are the same state — an admin who wants the toggle ON flips it and
    // the draft is dirty. Adding a `configured` flag would only unlock a
    // pristine Save that writes an audit entry asserting a change that never
    // happened (#2143).
  })

  async function saveSettings(next: BookingRequestSettings) {
    setSaving(true)
    setError("")
    setSuccess("")
    pricing.setError("")
    pricing.setSuccess("")
    try {
      applySettings(await putSettings(next))
      setSuccess("Booking request settings saved")
    } catch (err) {
      if (err instanceof ForbiddenSaveError) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON)
        return
      }
      setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setSaving(false)
    }
  }

  function handleSaveQuoteTiming() {
    const ttl = Number(ttlDraft)
    const reminder = Number(reminderDraft)
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 60) {
      setError("Quote response window must be a whole number of days between 1 and 60.")
      return
    }
    if (!Number.isInteger(reminder) || reminder < 0 || reminder > 30) {
      setError("Reminder lead time must be a whole number of days between 0 and 30.")
      return
    }
    if (reminder >= ttl) {
      setError("Reminder lead time must be shorter than the quote response window.")
      return
    }
    void saveSettings({
      ...settings,
      quoteResponseTtlDays: ttl,
      quoteReminderLeadDays: reminder,
    })
  }

  function handleSaveAttendeeTiming() {
    const lead = Number(attendeeLeadDraft)
    const reminder = Number(attendeeReminderDraft)
    if (!Number.isInteger(lead) || lead < 0 || lead > 90) {
      setError("The attendee prompt lead time must be a whole number of days between 0 and 90.")
      return
    }
    if (!Number.isInteger(reminder) || reminder < 1 || reminder > 30) {
      setError("The attendee reminder interval must be a whole number of days between 1 and 30.")
      return
    }
    void saveSettings({
      ...settings,
      attendeeConfirmationLeadDays: lead,
      attendeeConfirmationReminderDays: reminder,
    })
  }

  /*
    #2142: one section-level banner carries the view-only explanation —
    announced on arrival, in the reading order — instead of each disabled Save
    carrying its own copy. It, and `PolicyFeedback` below it, form the section's
    FRAME: both are rendered in EVERY state so their live regions are registered
    in the accessibility tree from the first paint and only their CONTENT
    changes. A region injected already-populated is silently dropped by some
    screen-reader/browser pairings, and a failed FIRST load would otherwise mount
    the section together with an already-populated alert in one commit. Only the
    cards below the frame are swapped for the loading placeholder.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the public booking request settings but cannot
      change them. Bookings edit access is required.
    </AdminViewOnlySectionBanner>
  )

  const pricingDraft = pricing.draft
  // Any write in the section disables every control in it, so a second card
  // cannot be submitted against a settings object that is mid-flight.
  const busy = saving || pricing.saving

  const timingDirty =
    Number(ttlDraft) !== settings.quoteResponseTtlDays ||
    Number(reminderDraft) !== settings.quoteReminderLeadDays
  const attendeeTimingDirty =
    Number(attendeeLeadDraft) !== settings.attendeeConfirmationLeadDays ||
    Number(attendeeReminderDraft) !== settings.attendeeConfirmationReminderDays

  return (
    <div>
      {viewOnlyBanner}
      <PolicyFeedback
        error={error || pricing.error}
        success={success || pricing.success}
        onClearError={() => {
          setError("")
          pricing.setError("")
        }}
        onClearSuccess={() => {
          setSuccess("")
          pricing.setSuccess("")
        }}
      />
      {pricing.loading || pricingDraft === null ? (
        <div className="text-center py-8">Loading...</div>
      ) : (
      <div className="space-y-6">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Indicative Pricing</CardTitle>
              <CardDescription>
                Control whether the public booking request form shows indicative pricing to non-members.
              </CardDescription>
            </div>
            {/*
              #2162: the toggle used to persist the moment it was clicked. It now
              stages behind this Edit, like every other control in Booking
              Policies, so an accidental click no longer changes what the public
              site shows.
            */}
            {!pricing.editing && (
              <ViewOnlyActionButton
                type="button"
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                size="sm"
                onClick={pricing.startEditing}
                disabled={busy}
              >
                Edit
              </ViewOnlyActionButton>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="showPricingToNonMembers"
                checked={pricingDraft.showPricingToNonMembers}
                onChange={(e) =>
                  pricing.setDraft({ showPricingToNonMembers: e.target.checked })
                }
                className="rounded border-input"
                disabled={!pricing.editing || busy}
              />
              <Label htmlFor="showPricingToNonMembers">Show indicative pricing on the request form</Label>
            </div>
            <p className="text-xs text-muted-foreground">
              When enabled, the public form is labelled &ldquo;Request to Book&rdquo; and shows an indicative
              price. When disabled, it is labelled &ldquo;Request for Price&rdquo; and no pricing is shown
              until an officer reviews the request.
            </p>
            <p className="text-xs text-muted-foreground">
              Submitted requests that are declined, or never have their email verified, are automatically
              purged after 90 days in line with the Privacy Act 2020.
            </p>

            {pricing.editing && (
              <div className="flex space-x-3">
                <ViewOnlyActionButton
                  type="button"
                  canEdit={canEdit}
                  describeReason={false}
                  onClick={() => void pricing.save()}
                  disabled={busy || !pricing.dirty || !canEdit}
                >
                  {pricing.saving ? "Saving…" : "Save indicative pricing"}
                </ViewOnlyActionButton>
                <Button
                  type="button"
                  variant="outline"
                  onClick={pricing.cancelEditing}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Quote Response Window &amp; Reminders</CardTitle>
            <CardDescription>
              Set how long a quote link stays valid after you send it, and when the requester is reminded
              before it expires.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-1">
              <Label htmlFor="quoteResponseTtlDays">Quote response window (days)</Label>
              <input
                type="number"
                id="quoteResponseTtlDays"
                min={1}
                max={60}
                value={ttlDraft}
                onChange={(e) => setTtlDraft(e.target.value)}
                className="block w-28 rounded border border-input px-2 py-1 text-sm"
                disabled={busy || !canEdit}
              />
              <p className="text-xs text-muted-foreground">
                How many days the requester has to accept, cancel, or reply before the secure quote link
                expires. Applies to quotes sent from now on; quotes already sent keep their original expiry.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="quoteReminderLeadDays">Reminder lead time (days before expiry)</Label>
              <input
                type="number"
                id="quoteReminderLeadDays"
                min={0}
                max={30}
                value={reminderDraft}
                onChange={(e) => setReminderDraft(e.target.value)}
                className="block w-28 rounded border border-input px-2 py-1 text-sm"
                disabled={busy || !canEdit}
              />
              <p className="text-xs text-muted-foreground">
                Send the requester one reminder this many days before the quote expires. The reminder
                contains a fresh, working quote link so they never have to find the original email. Set to
                0 to turn reminders off. Must be shorter than the response window above.
              </p>
            </div>

            {/*
              #2142: these two Saves were already gated correctly, but as raw
              <button> elements they were unthemed and could not participate in the
              shared view-only treatment. `ViewOnlyActionButton` keeps the
              resolving (`undefined`) window neutral, and `describeReason={false}`
              defers the explanation to the section banner above (a disabled button
              is out of the tab order, so its own reason was never reachable). The
              existing `!canEdit` term is now redundant with the wrapper's own
              `canEdit !== true` check; it is kept so the gate is legible here
              rather than only inside the wrapper.
            */}
            <ViewOnlyActionButton
              type="button"
              canEdit={canEdit}
              describeReason={false}
              onClick={handleSaveQuoteTiming}
              disabled={busy || !timingDirty || !canEdit}
            >
              {saving ? "Saving…" : "Save quote timing"}
            </ViewOnlyActionButton>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>School Attendee Confirmation</CardTitle>
            <CardDescription>
              Before a school group arrives, the school contact is emailed a secure link to replace the
              placeholder attendee names and confirm who is coming. The chore roster uses the confirmed
              names.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="attendeeConfirmationLeadDays">First prompt (days before check-in)</Label>
              <input
                type="number"
                id="attendeeConfirmationLeadDays"
                min={0}
                max={90}
                value={attendeeLeadDraft}
                onChange={(e) => setAttendeeLeadDraft(e.target.value)}
                className="block w-28 rounded border border-input px-2 py-1 text-sm"
                disabled={busy || !canEdit}
              />
              <p className="text-xs text-muted-foreground">
                Start prompting the school this many days before check-in. Set to 0 to turn the prompts
                off.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="attendeeConfirmationReminderDays">Reminder interval (days)</Label>
              <input
                type="number"
                id="attendeeConfirmationReminderDays"
                min={1}
                max={30}
                value={attendeeReminderDraft}
                onChange={(e) => setAttendeeReminderDraft(e.target.value)}
                className="block w-28 rounded border border-input px-2 py-1 text-sm"
                disabled={busy || !canEdit}
              />
              <p className="text-xs text-muted-foreground">
                Keep re-sending the confirmation link this often until the school confirms the list or
                check-in arrives. Each email carries a fresh working link.
              </p>
            </div>

            <ViewOnlyActionButton
              type="button"
              canEdit={canEdit}
              describeReason={false}
              onClick={handleSaveAttendeeTiming}
              disabled={busy || !attendeeTimingDirty || !canEdit}
            >
              {saving ? "Saving…" : "Save attendee prompts"}
            </ViewOnlyActionButton>
          </CardContent>
        </Card>
      </div>
      )}
    </div>
  )
}
