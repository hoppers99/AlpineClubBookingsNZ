"use client"

import { useCallback, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state"
import { AdminViewOnlySectionBanner, ViewOnlyActionButton } from "@/components/admin/view-only-action"
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
 * The three cards' drafts (#2162, #2166).
 *
 * All five settings live in ONE server-side row behind ONE whole-object PUT, so
 * a single `useSectionEditState` instance for the whole section would match the
 * storage exactly. It still cannot be used, and the reason survived the #2166
 * decision to Edit-gate the timing cards: the hook carries ONE `editing` flag,
 * and three cards sharing it would mean one Edit unlocking all three, one
 * Cancel discarding all three drafts, and one Save writing all five fields. The
 * owner decision in #2166 was explicitly per-card Edit gating, NOT a
 * section-level Edit — so each card keeps its own instance, its own Edit, its
 * own dirty gate, and its own Cancel.
 *
 * The price of three instances is the shared write object, and it is paid the
 * documented way (`AGENTS.md`, `docs/ARCHITECTURE.md`): every save GETs the
 * fresh settings and merges only its own fields, exactly as the magic-link and
 * Google cards do against `PUT /api/admin/modules`. That is what keeps a card
 * from writing a sibling card's UNSAVED draft, or its own stale snapshot of
 * one, back over storage.
 *
 * The two timing drafts hold STRINGS, because their editors are free-text
 * number boxes an admin can legitimately leave mid-typed ("", "1", "0"). They
 * are declared as type aliases rather than interfaces so they carry the
 * implicit index signature {@link isTimingDirty} needs.
 */
interface PricingDraft {
  showPricingToNonMembers: boolean
}

type QuoteTimingDraft = {
  quoteResponseTtlDays: string
  quoteReminderLeadDays: string
}

type AttendeeTimingDraft = {
  attendeeConfirmationLeadDays: string
  attendeeConfirmationReminderDays: string
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

function toQuoteTimingDraft(data: BookingRequestSettings): QuoteTimingDraft {
  return {
    quoteResponseTtlDays: String(data.quoteResponseTtlDays),
    quoteReminderLeadDays: String(data.quoteReminderLeadDays),
  }
}

function toAttendeeTimingDraft(data: BookingRequestSettings): AttendeeTimingDraft {
  return {
    attendeeConfirmationLeadDays: String(data.attendeeConfirmationLeadDays),
    attendeeConfirmationReminderDays: String(data.attendeeConfirmationReminderDays),
  }
}

/**
 * Dirty check for the two timing cards.
 *
 * Their drafts are strings but the stored values are integers, so the
 * comparison is NUMERIC — `07` is not a change from `7`, and an emptied box is
 * not a change from `0`. That is the same comparison the pre-#2166 hand-rolled
 * `timingDirty` / `attendeeTimingDirty` flags made, kept deliberately: a plain
 * string compare would arm Save for a re-typing that stores nothing, and the
 * write logs `booking_request.settings_updated` unconditionally (#2143).
 *
 * A box the admin has made unparseable (`abc` -> `NaN`) still counts as dirty,
 * so Save stays clickable and the card's own validation can explain what is
 * wrong rather than leaving a greyed-out button with no reason.
 */
function isTimingDirty<T extends Record<string, string>>(draft: T, saved: T) {
  return (Object.keys(draft) as (keyof T & string)[]).some(
    (field) => Number(draft[field]) !== Number(saved[field]),
  )
}

/**
 * Shown when the fresh read a save takes fails for any reason other than a 403
 * (which has its own narrowed-actor copy). It has to say the change did not
 * land: the admin clicked Save, not Reload.
 */
const SAVE_STEP_READ_FAILED =
  "Your change was not saved: the current settings could not be re-read. Please try again."

/** Every card reports the same thing, because they all write the same row. */
const SAVE_SUCCESS = "Booking request settings saved"

/**
 * The section's only read, in both of its roles: the mount-time load, and the
 * fresh read every card takes immediately before it writes.
 *
 * `asSaveStep` says which. A save's fresh read is part of the WRITE, so a 403
 * on it means the actor was narrowed since page load and belongs in the shared
 * "this change was not saved" copy — the same mapping `google-security-card.tsx`
 * applies to its own fresh read of `/api/admin/modules`. The mount-time load is
 * an ordinary GET on `bookings:view`, so the same status there is a genuine read
 * failure and keeps the generic message.
 *
 * Only the load passes an `AbortSignal` (a hook's, aborted on unmount). The
 * save path deliberately does not, matching the precedent above: aborting the
 * read half of a save would leave the write undecided rather than cancelled,
 * and the PUT it feeds is not abortable either.
 */
async function fetchSettings(
  options: { signal?: AbortSignal; asSaveStep?: boolean } = {},
): Promise<BookingRequestSettings> {
  const res = await fetch(ENDPOINT, options.signal ? { signal: options.signal } : undefined)
  if (!res.ok) {
    if (options.asSaveStep) {
      if (res.status === 403) throw new ForbiddenSaveError()
      // Any other failure of the save's fresh read means the PUT never went out.
      // The message lands in the error region the admin is watching after
      // clicking Save, so read-flavoured copy there would report a failure they
      // did not ask for and say nothing about the change they did (#2162
      // review).
      throw new Error(SAVE_STEP_READ_FAILED)
    }
    throw new Error("Failed to fetch booking request settings")
  }
  return (await res.json()) as BookingRequestSettings
}

/**
 * The section's only write. The route takes the whole settings object, so every
 * card sends all five fields. No card may source the fields it does not own from
 * its load-time snapshot: each one GETs the fresh row through
 * {@link fetchSettings} and merges only its own fields over it, so everything
 * else on the wire is what is STORED right now.
 *
 * Throws {@link ForbiddenSaveError} for a 403 so all three cards map it to the
 * same shared copy through the hook.
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

/** The slice of a card's state a SIBLING card needs in order to clear it. */
interface ClearableFeedback {
  setError: (message: string) => void
  setSuccess: (message: string) => void
}

/**
 * All three cards report through one `PolicyFeedback`, so a card starting a save
 * clears the other two first — otherwise one card's stale confirmation sits
 * above another card's fresh result. Each hook already clears its OWN pair when
 * its save starts.
 */
function clearOtherFeedback(...others: ClearableFeedback[]) {
  for (const card of others) {
    card.setError("")
    card.setSuccess("")
  }
}

export function PublicBookingRequestsSection() {
  // Booking-request settings gate on the bookings area (its write route enforces
  // bookings:edit); a bookings:view admin sees the whole section read-only
  // (#1940). Since #2162/#2166 no control in it auto-persists, so the gate is
  // purely about which affordances are offered, not about a silent 403.
  const canEdit = useAdminAreaEditAccess("bookings")

  /**
   * ONE mount-time GET for the whole section, shared by the three cards' loads.
   *
   * Each card owns a `useSectionEditState` instance and the hook fetches per
   * instance, so without this the section would issue three identical GETs on
   * mount — and, worse, three snapshots that a write landing between them could
   * leave disagreeing about the same row. The three `load` callbacks run in the
   * same commit, so they all reach this before the request settles and all
   * three seed from the SAME response.
   *
   * The ref is cleared once the request settles so a later `reload` (none today)
   * would fetch again rather than replay a stale body. Only the first caller's
   * `AbortSignal` is honoured; the three are aborted together on unmount, and
   * the hook swallows the resulting `AbortError` in every instance.
   */
  const inflightLoad = useRef<Promise<BookingRequestSettings> | null>(null)
  const loadSettings = useCallback((signal: AbortSignal) => {
    if (!inflightLoad.current) {
      const pending = fetchSettings({ signal })
      const release = () => {
        if (inflightLoad.current === pending) inflightLoad.current = null
      }
      // Both arms, so a failed load does not pin the rejected promise in the ref.
      pending.then(release, release)
      inflightLoad.current = pending
    }
    return inflightLoad.current
  }, [])

  /*
    #2162: the Indicative Pricing card. The toggle used to persist the moment it
    was clicked; it now stages behind an Edit, like every other control in
    Booking Policies.
  */
  const pricing = useSectionEditState<PricingDraft>({
    initial: { showPricingToNonMembers: SETTINGS_FALLBACK.showPricingToNonMembers },
    load: async (signal) => ({
      showPricingToNonMembers: (await loadSettings(signal)).showPricingToNonMembers,
    }),
    save: async (draft) => {
      // GET-fresh-then-merge over the shared whole-object PUT: write the STORED
      // timing values plus this card's new one, never the snapshot this card
      // happened to load with and never a timing draft the admin has typed but
      // not saved.
      const fresh = await fetchSettings({ asSaveStep: true })
      const next = await putSettings({
        ...fresh,
        showPricingToNonMembers: draft.showPricingToNonMembers,
      })
      return { showPricingToNonMembers: next.showPricingToNonMembers }
    },
    successMessage: SAVE_SUCCESS,
    // No first-save exception on any of the three cards, even though the GET
    // SYNTHESISES defaults when no row is stored (`getBookingRequestSettings`).
    // The exception exists so a form whose defaults are already correct can
    // still commit them — but here the synthesised defaults ARE the effective
    // settings at every read site, and nothing downstream keys on the row
    // existing (no setup-checklist entry, no create/delete semantics). An admin
    // who wants a different value types it and the draft is dirty; an admin
    // happy with the defaults has nothing to commit. Adding a `configured` flag
    // would only unlock a pristine Save that writes an audit entry asserting a
    // change that never happened (#2143).
  })

  /*
    #2166 (owner decision): the two timing cards used to be always-editable with
    a dirty-gated Save and no Edit or Cancel — the last acknowledged divergence
    from the canonical settings pattern in Booking Policies. They now follow the
    pricing card exactly: read-only until Edit, Save and Cancel only while
    editing, Save gated on `dirty`.
  */
  const quoteTiming = useSectionEditState<QuoteTimingDraft>({
    initial: toQuoteTimingDraft(SETTINGS_FALLBACK),
    load: async (signal) => toQuoteTimingDraft(await loadSettings(signal)),
    save: async (draft) => {
      // Same GET-fresh-then-merge. Both fields of the route's cross-field rule
      // (`quoteReminderLeadDays < quoteResponseTtlDays`) are owned by THIS card,
      // so merging over the fresh row cannot compose an invalid pair.
      const fresh = await fetchSettings({ asSaveStep: true })
      return toQuoteTimingDraft(
        await putSettings({
          ...fresh,
          quoteResponseTtlDays: Number(draft.quoteResponseTtlDays),
          quoteReminderLeadDays: Number(draft.quoteReminderLeadDays),
        }),
      )
    },
    successMessage: SAVE_SUCCESS,
    isDirty: isTimingDirty,
  })

  const attendeeTiming = useSectionEditState<AttendeeTimingDraft>({
    initial: toAttendeeTimingDraft(SETTINGS_FALLBACK),
    load: async (signal) => toAttendeeTimingDraft(await loadSettings(signal)),
    save: async (draft) => {
      const fresh = await fetchSettings({ asSaveStep: true })
      return toAttendeeTimingDraft(
        await putSettings({
          ...fresh,
          attendeeConfirmationLeadDays: Number(draft.attendeeConfirmationLeadDays),
          attendeeConfirmationReminderDays: Number(
            draft.attendeeConfirmationReminderDays,
          ),
        }),
      )
    },
    successMessage: SAVE_SUCCESS,
    isDirty: isTimingDirty,
  })

  /*
    #2166: `beginSaveDraftSync` is GONE, and nothing replaces it.

    It existed because every card wrote through ONE shared `settings` snapshot
    that every save re-seeded from its fresh read. That read can legitimately
    move a field this admin never touched, so a sibling card's untouched draft
    box could end up disagreeing with the snapshot its dirty flag compared
    against — arming a Save nobody armed, one click from silently reverting the
    other admin.

    There is no shared snapshot any more. Each card's draft and snapshot live in
    its own hook instance and are only ever re-seeded TOGETHER, by that card's
    own load or its own save. No card's save can leave a sibling dirty, so the
    hazard is structurally impossible rather than defended against.

    What is left is display staleness: after a save, a card the admin did not
    touch still shows the values it loaded with, even if the fresh read revealed
    that a second admin has moved them. That is the same accepted property the
    module-toggle cards on `/admin/security` have — and it is now strictly
    safer than it was, because those values sit behind a read-only card whose
    Save is unreachable until the admin clicks Edit, and dirty-gated against a
    snapshot that matches what is on screen when they do. Do NOT "fix" it by
    having one card's save re-seed another card's state: that is the coupling
    this removed.
  */

  const busy = pricing.saving || quoteTiming.saving || attendeeTiming.saving
  const loading = pricing.loading || quoteTiming.loading || attendeeTiming.loading

  // `initial` is always supplied, so these are never actually null once loading
  // clears; the checks below exist only to narrow the hook's `T | null`, which
  // is `null` only for a card that renders nothing until its fetch resolves.
  const pricingDraft = pricing.draft
  const quoteDraft = quoteTiming.draft
  const attendeeDraft = attendeeTiming.draft

  function handleSavePricing() {
    clearOtherFeedback(quoteTiming, attendeeTiming)
    void pricing.save()
  }

  /*
    Validation stays in the click handler rather than in the hook's `isValid`.
    `isValid` would only grey the Save button out, leaving the admin with a dead
    control and no reason for it — and the reason (which field, which range,
    which cross-field rule) is exactly what they need. Save therefore stays
    enabled for a dirty-but-invalid draft and the click explains the problem.
  */
  function handleSaveQuoteTiming(draft: QuoteTimingDraft) {
    clearOtherFeedback(pricing, attendeeTiming)
    const ttl = Number(draft.quoteResponseTtlDays)
    const reminder = Number(draft.quoteReminderLeadDays)
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 60) {
      quoteTiming.setError(
        "Quote response window must be a whole number of days between 1 and 60.",
      )
      return
    }
    if (!Number.isInteger(reminder) || reminder < 0 || reminder > 30) {
      quoteTiming.setError(
        "Reminder lead time must be a whole number of days between 0 and 30.",
      )
      return
    }
    if (reminder >= ttl) {
      quoteTiming.setError(
        "Reminder lead time must be shorter than the quote response window.",
      )
      return
    }
    void quoteTiming.save()
  }

  function handleSaveAttendeeTiming(draft: AttendeeTimingDraft) {
    clearOtherFeedback(pricing, quoteTiming)
    const lead = Number(draft.attendeeConfirmationLeadDays)
    const reminder = Number(draft.attendeeConfirmationReminderDays)
    if (!Number.isInteger(lead) || lead < 0 || lead > 90) {
      attendeeTiming.setError(
        "The attendee prompt lead time must be a whole number of days between 0 and 90.",
      )
      return
    }
    if (!Number.isInteger(reminder) || reminder < 1 || reminder > 30) {
      attendeeTiming.setError(
        "The attendee reminder interval must be a whole number of days between 1 and 30.",
      )
      return
    }
    void attendeeTiming.save()
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

  return (
    <div>
      {viewOnlyBanner}
      <PolicyFeedback
        error={pricing.error || quoteTiming.error || attendeeTiming.error}
        success={pricing.success || quoteTiming.success || attendeeTiming.success}
        onClearError={() => {
          pricing.setError("")
          quoteTiming.setError("")
          attendeeTiming.setError("")
        }}
        onClearSuccess={() => {
          pricing.setSuccess("")
          quoteTiming.setSuccess("")
          attendeeTiming.setSuccess("")
        }}
      />
      {loading ||
      pricingDraft === null ||
      quoteDraft === null ||
      attendeeDraft === null ? (
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
              #2166: all three cards now carry an Edit, so the shared visible
              word cannot be the whole accessible name — a screen reader's
              button list would show three identical "Edit"s, the same defect
              #2142 fixed for the two look-alike "Deactivate" buttons on a
              minimum-stay row. Each one therefore carries an `aria-label`
              naming its card, matching that card's already-distinct Save label
              and leaving the visible button exactly as it looks today. The
              label still STARTS with the visible word, so it satisfies
              WCAG 2.5.3 Label in Name for speech input. Same treatment on
              Cancel, which can legitimately appear three times at once.
            */}
            {!pricing.editing && (
              <ViewOnlyActionButton
                type="button"
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                size="sm"
                aria-label="Edit indicative pricing"
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
                  onClick={handleSavePricing}
                  disabled={busy || !pricing.dirty || !canEdit}
                >
                  {pricing.saving ? "Saving…" : "Save indicative pricing"}
                </ViewOnlyActionButton>
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Cancel indicative pricing"
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
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>Quote Response Window &amp; Reminders</CardTitle>
              <CardDescription>
                Set how long a quote link stays valid after you send it, and when the requester is reminded
                before it expires.
              </CardDescription>
            </div>
            {!quoteTiming.editing && (
              <ViewOnlyActionButton
                type="button"
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                size="sm"
                aria-label="Edit quote timing"
                onClick={quoteTiming.startEditing}
                disabled={busy}
              >
                Edit
              </ViewOnlyActionButton>
            )}
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="space-y-1">
              <Label htmlFor="quoteResponseTtlDays">Quote response window (days)</Label>
              <input
                type="number"
                id="quoteResponseTtlDays"
                min={1}
                max={60}
                value={quoteDraft.quoteResponseTtlDays}
                onChange={(e) =>
                  quoteTiming.setDraft({ quoteResponseTtlDays: e.target.value })
                }
                className="block w-28 rounded border border-input px-2 py-1 text-sm"
                disabled={!quoteTiming.editing || busy}
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
                value={quoteDraft.quoteReminderLeadDays}
                onChange={(e) =>
                  quoteTiming.setDraft({ quoteReminderLeadDays: e.target.value })
                }
                className="block w-28 rounded border border-input px-2 py-1 text-sm"
                disabled={!quoteTiming.editing || busy}
              />
              <p className="text-xs text-muted-foreground">
                Send the requester one reminder this many days before the quote expires. The reminder
                contains a fresh, working quote link so they never have to find the original email. Set to
                0 to turn reminders off. Must be shorter than the response window above.
              </p>
            </div>

            {/*
              #2142: these Saves were already gated correctly, but as raw
              <button> elements they were unthemed and could not participate in
              the shared view-only treatment. `ViewOnlyActionButton` keeps the
              resolving (`undefined`) window neutral, and `describeReason={false}`
              defers the explanation to the section banner above (a disabled button
              is out of the tab order, so its own reason was never reachable). The
              existing `!canEdit` term is now redundant with the wrapper's own
              `canEdit !== true` check; it is kept so the gate is legible here
              rather than only inside the wrapper.
            */}
            {quoteTiming.editing && (
              <div className="flex space-x-3">
                <ViewOnlyActionButton
                  type="button"
                  canEdit={canEdit}
                  describeReason={false}
                  onClick={() => handleSaveQuoteTiming(quoteDraft)}
                  disabled={busy || !quoteTiming.dirty || !canEdit}
                >
                  {quoteTiming.saving ? "Saving…" : "Save quote timing"}
                </ViewOnlyActionButton>
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Cancel quote timing"
                  onClick={quoteTiming.cancelEditing}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle>School Attendee Confirmation</CardTitle>
              <CardDescription>
                Before a school group arrives, the school contact is emailed a secure link to replace the
                placeholder attendee names and confirm who is coming. The chore roster uses the confirmed
                names.
              </CardDescription>
            </div>
            {!attendeeTiming.editing && (
              <ViewOnlyActionButton
                type="button"
                canEdit={canEdit}
                describeReason={false}
                variant="outline"
                size="sm"
                aria-label="Edit attendee prompts"
                onClick={attendeeTiming.startEditing}
                disabled={busy}
              >
                Edit
              </ViewOnlyActionButton>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="attendeeConfirmationLeadDays">First prompt (days before check-in)</Label>
              <input
                type="number"
                id="attendeeConfirmationLeadDays"
                min={0}
                max={90}
                value={attendeeDraft.attendeeConfirmationLeadDays}
                onChange={(e) =>
                  attendeeTiming.setDraft({
                    attendeeConfirmationLeadDays: e.target.value,
                  })
                }
                className="block w-28 rounded border border-input px-2 py-1 text-sm"
                disabled={!attendeeTiming.editing || busy}
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
                value={attendeeDraft.attendeeConfirmationReminderDays}
                onChange={(e) =>
                  attendeeTiming.setDraft({
                    attendeeConfirmationReminderDays: e.target.value,
                  })
                }
                className="block w-28 rounded border border-input px-2 py-1 text-sm"
                disabled={!attendeeTiming.editing || busy}
              />
              <p className="text-xs text-muted-foreground">
                Keep re-sending the confirmation link this often until the school confirms the list or
                check-in arrives. Each email carries a fresh working link.
              </p>
            </div>

            {attendeeTiming.editing && (
              <div className="flex space-x-3">
                <ViewOnlyActionButton
                  type="button"
                  canEdit={canEdit}
                  describeReason={false}
                  onClick={() => handleSaveAttendeeTiming(attendeeDraft)}
                  disabled={busy || !attendeeTiming.dirty || !canEdit}
                >
                  {attendeeTiming.saving ? "Saving…" : "Save attendee prompts"}
                </ViewOnlyActionButton>
                <Button
                  type="button"
                  variant="outline"
                  aria-label="Cancel attendee prompts"
                  onClick={attendeeTiming.cancelEditing}
                  disabled={busy}
                >
                  Cancel
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      )}
    </div>
  )
}
