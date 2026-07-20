"use client"

import { useEffect, useRef, useState } from "react"
import {
  cancellationRuleSetsEqual,
  normalizeCancellationRule,
} from "@/lib/cancellation-rules"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CancellationRulesEditor } from "./cancellation-rules-editor"
import { PolicyPreview } from "./policy-preview"
import { PolicyFeedback } from "./policy-feedback"
import { PolicyScopeSelect, usePolicyScopeLodgeName } from "./policy-scope-select"
import { useLodgeOptions } from "@/components/lodge-select"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state"
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import type { PolicyRule } from "./types"

type WaitlistCrossLodgeOrder = "OWN_LODGE_FIRST" | "MERGED"

const FALLBACK_RULES: PolicyRule[] = [
  { daysBeforeStay: 14, refundPercentage: 100, creditRefundPercentage: 100, fixedFeeCents: 0, creditFixedFeeCents: 0 },
  { daysBeforeStay: 7, refundPercentage: 50, creditRefundPercentage: 50, fixedFeeCents: 0, creditFixedFeeCents: 0 },
  { daysBeforeStay: 0, refundPercentage: 0, creditRefundPercentage: 0, fixedFeeCents: 0, creditFixedFeeCents: 0 },
]

const ENDPOINT = "/api/admin/booking-policies/cancellation"

function endpointFor(lodgeId: string | null) {
  return lodgeId ? `${ENDPOINT}?lodgeId=${encodeURIComponent(lodgeId)}` : ENDPOINT
}

/**
 * The section's draft. Unlike the two list sections, this one edits a single
 * config object per SCOPE, so a single `useSectionEditState` instance owns it
 * and the scope switch drives `reload`.
 */
interface CancellationDraft {
  rules: PolicyRule[]
  holdEnabled: boolean
  holdDays: number
  waitlistOrder: WaitlistCrossLodgeOrder
  /**
   * Whether this partition actually has persisted rules, as reported by the GET
   * (#2142). A partition with no rows yet gets `FALLBACK_RULES` seeded into
   * BOTH the draft and the snapshot, so without this flag the #2143 dirty gate
   * would make committing the defaults unreachable. Never sent to the server.
   */
  configured: boolean
  /**
   * The scope this value was loaded for — `null` for club-wide, otherwise the
   * lodge id (#2142 review). `useSectionEditState` leaves `saved`/`draft`
   * untouched when a load FAILS, so after a failed scope switch the snapshot
   * still describes the PREVIOUS partition. Two decisions are derived from the
   * snapshot — whether this lodge has an override, and whether the first-save
   * exception applies — and both are nonsense when it belongs to a different
   * scope: a club-wide policy would masquerade as a phantom lodge override
   * (offering a Remove that writes a no-op audit entry, exactly the #2143
   * erosion this change exists to stop), and a club-wide `configured: false`
   * would carry across and let one click blind-write `FALLBACK_RULES` as a new
   * lodge override. So the scope travels WITH the snapshot, and a mismatch is
   * treated as "unknown" until a load for the current scope succeeds.
   */
  scope: string | null
}

const CANCELLATION_DEFAULTS: CancellationDraft = {
  // Deliberately `configured: true`: this seed is also the fallback a FAILED
  // load leaves in the form, where we know nothing about the stored rows.
  // Claiming "nothing persisted" would enable a pristine Save that blind-writes
  // these rules over a club's real policy. Failing closed costs nothing — the
  // admin can still save after changing a field, or reload.
  configured: true,
  // The section always mounts on the club-wide scope, so this seed matches it.
  scope: null,
  rules: FALLBACK_RULES,
  holdEnabled: true,
  holdDays: 7,
  waitlistOrder: "OWN_LODGE_FIRST",
}

function toDraft(
  data: {
    rules?: PolicyRule[]
    nonMemberHoldEnabled?: boolean
    nonMemberHoldDays?: number
    waitlistCrossLodgeOrder?: string
  },
  lodgeId: string | null,
): CancellationDraft {
  const fetchedRules: PolicyRule[] = (data.rules ?? []).map((rule) =>
    normalizeCancellationRule(rule),
  )
  return {
    // Club-wide with no rows yet gets a sensible editable starting point. A
    // lodge with no rows has NO override — seeding defaults there would invite
    // accidentally creating one, so keep the list empty instead.
    rules: fetchedRules.length > 0 || lodgeId ? fetchedRules : FALLBACK_RULES,
    holdEnabled: data.nonMemberHoldEnabled ?? true,
    holdDays: data.nonMemberHoldDays ?? 7,
    waitlistOrder:
      data.waitlistCrossLodgeOrder === "MERGED" ? "MERGED" : "OWN_LODGE_FIRST",
    configured: fetchedRules.length > 0,
    scope: lodgeId,
  }
}

export function DefaultCancellationPolicySection() {
  // Per-lodge override scope (ADR-001 resolved question 3): null edits the
  // club-wide rules; a lodge edits that lodge's override set, which replaces
  // the club-wide set entirely at runtime. The scope control renders nothing
  // while fewer than two lodges exist.
  const [scopeLodgeId, setScopeLodgeId] = useState<string | null>(null)
  const scopeLodgeName = usePolicyScopeLodgeName(scopeLodgeId)
  // Optimistic "an override is being created" flag: the editor opens seeded
  // from the club-wide rules before anything is persisted for this lodge.
  const [creatingOverride, setCreatingOverride] = useState(false)
  const [removingOverride, setRemovingOverride] = useState(false)
  const { lodges } = useLodgeOptions("admin")
  // Booking-policy config gates on the bookings area (its write route enforces
  // bookings:edit); a bookings:view admin sees it read-only (#1940).
  const canEdit = useAdminAreaEditAccess("bookings")

  // Mirrors `scopeLodgeId` for the async callbacks below, which need to know
  // the CURRENT scope at the moment they resolve rather than the one they
  // closed over. Assigned in an effect, never during render.
  const scopeRef = useRef(scopeLodgeId)

  const section = useSectionEditState<CancellationDraft>({
    // Seeded so a failed load still renders the form with its defaults
    // alongside the error, as it always has.
    initial: CANCELLATION_DEFAULTS,
    load: async (signal) => {
      // `useSectionEditState` reads its callbacks from a latest-ref refreshed on
      // every commit, so this closure always carries the CURRENT scope.
      const scope = scopeLodgeId
      const res = await fetch(endpointFor(scope), { signal })
      if (!res.ok) throw new Error("Failed to fetch policy")
      const data = await res.json()
      // A scope switch during the fetch makes this response the wrong
      // partition's. `reload` cannot abort the in-flight request the way the
      // mount-time controller does, so drop it the one way the hook already
      // understands: it swallows AbortError without touching state.
      if (scopeRef.current !== scope) {
        throw new DOMException("Stale policy scope", "AbortError")
      }
      return toDraft(data, scope)
    },
    save: async (draft) => {
      const lodgeId = scopeLodgeId
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rules: draft.rules,
          // Hold enablement, hold days, and waitlist queue order are club-wide;
          // only the club-wide scope edits them.
          ...(lodgeId
            ? { lodgeId }
            : {
                nonMemberHoldEnabled: draft.holdEnabled,
                nonMemberHoldDays: draft.holdDays,
                waitlistCrossLodgeOrder: draft.waitlistOrder,
              }),
        }),
      })
      if (!res.ok) {
        if (res.status === 403) throw new ForbiddenSaveError()
        const data = await res.json()
        throw new Error(data.error || "Failed to save")
      }
      // The PUT echoes the stored partition back, so re-seed from THAT — the
      // route sorts and normalises the rules it persists.
      return toDraft(await res.json(), lodgeId)
    },
    successMessage: () =>
      scopeLodgeId
        ? `Override saved for ${scopeLodgeName ?? "lodge"}`
        : "Default policy saved",
    // #2143: an Edit -> Save that changed nothing must not reach the PUT, which
    // logs `cancellation-policy.update` and revalidates the public pages
    // unconditionally — so a no-op save left an audit entry asserting a policy
    // change that never happened. The one exception is the first save on a
    // partition with no persisted rows (club-wide on a club that never saved
    // one, or a lodge whose override is being created): the form seeded itself
    // from FALLBACK_RULES or from the club-wide rules, so there is nothing for
    // the draft to be unchanged FROM and committing those values must stay
    // reachable (#2142).
    isDirty: (draft, saved) => {
      // A snapshot loaded for another scope is not authoritative for this one,
      // so nothing can be judged changed (or first-saveable) against it. The
      // editor is hidden in that state anyway; this is the second lock.
      if (draft.scope !== scopeLodgeId || saved.scope !== scopeLodgeId) {
        return false
      }
      return (
        !draft.configured ||
        draft.holdEnabled !== saved.holdEnabled ||
        draft.holdDays !== saved.holdDays ||
        draft.waitlistOrder !== saved.waitlistOrder ||
        !cancellationRuleSetsEqual(draft.rules, saved.rules)
      )
    },
  })

  const { draft, saved, editing, saving, dirty, error, success } = section
  const { reload } = section

  // Re-fetch when the scope changes. The hook's own load is mount-only, so a
  // scope switch drives `reload`; the first run is the mount load itself.
  const scopeSettled = useRef(false)
  useEffect(() => {
    scopeRef.current = scopeLodgeId
    if (!scopeSettled.current) {
      scopeSettled.current = true
      return
    }
    setCreatingOverride(false)
    void reload()
  }, [scopeLodgeId, reload])

  function handleCancelDefaults() {
    section.cancelEditing()
    // Cancelling an unsaved "create override" must also drop the optimistic
    // override state; a refetch restores whatever the server actually holds.
    if (scopeLodgeId && (saved?.rules.length ?? 0) === 0) {
      setCreatingOverride(false)
      void reload()
    }
  }

  async function handleCreateOverride() {
    section.setError("")
    section.setSuccess("")
    try {
      // Seed the editor from the club-wide rules so the override starts as
      // a copy the admin adjusts, not a blank slate.
      const res = await fetch(ENDPOINT)
      if (!res.ok) throw new Error("Failed to fetch policy")
      const clubWide = toDraft(await res.json(), null)
      section.setDraft({
        rules: clubWide.rules.length > 0 ? clubWide.rules : FALLBACK_RULES,
      })
      setCreatingOverride(true)
      section.startEditing()
    } catch (err) {
      section.setError(err instanceof Error ? err.message : "Unknown error")
    }
  }

  /**
   * Removing an override is a destructive ACTION, not a draft/snapshot save:
   * it deletes the lodge's rows regardless of what the open editor holds, so it
   * deliberately bypasses `section.save()` (and its dirty gate) and reloads.
   */
  async function handleRemoveOverride() {
    if (
      !window.confirm(
        `Remove ${scopeLodgeName ?? "this lodge"}'s cancellation rules? Bookings there will use the club-wide rules again.`,
      )
    ) {
      return
    }
    if (!scopeLodgeId) return
    setRemovingOverride(true)
    section.setError("")
    section.setSuccess("")
    try {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules: [], lodgeId: scopeLodgeId }),
      })
      if (!res.ok) {
        if (res.status === 403) {
          section.setError(ADMIN_FORBIDDEN_SAVE_REASON)
          return
        }
        const data = await res.json()
        throw new Error(data.error || "Failed to save")
      }
      setCreatingOverride(false)
      await reload()
      section.setSuccess("Override removed — this lodge uses the club-wide rules")
    } catch (err) {
      section.setError(err instanceof Error ? err.message : "Unknown error")
    } finally {
      setRemovingOverride(false)
    }
  }

  /*
    #2142: the view-only explanation lives here, once, at the top of the
    section — announced on arrival and in the reading order — instead of on each
    disabled button below. It is rendered in BOTH branches below, in the same
    position, so the polite live region is registered in the accessibility tree
    from the first paint and only its CONTENT changes when `canEdit` resolves. A
    region injected already-populated is silently dropped by some
    screen-reader/browser pairings.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the cancellation policy but cannot change it.
      Bookings edit access is required.
    </AdminViewOnlySectionBanner>
  )

  if (section.loading || !draft) {
    return (
      <div>
        {viewOnlyBanner}
        <div className="text-center py-8">Loading...</div>
      </div>
    )
  }

  const scopeIsLodge = scopeLodgeId !== null
  // The invariant behind every derivation below: a snapshot is authoritative
  // ONLY for the scope it was loaded for. A failed scope switch leaves the
  // previous partition's snapshot in place (the hook does not clear it), and
  // the current scope's real state is then simply UNKNOWN — no editor, no
  // override affordances, no first-save exception, until a load for this scope
  // succeeds. Reading the stale snapshot instead would show a phantom override
  // built from the club-wide rules, whose Remove button writes a no-op
  // `cancellation-policy.update` entry (#2143) and whose Save creates an
  // override the admin never chose for this lodge.
  const scopeKnown = saved !== null && saved.scope === scopeLodgeId
  const hasOverride =
    creatingOverride || (scopeKnown && (saved?.rules.length ?? 0) > 0)
  const showEditor = scopeKnown && (!scopeIsLodge || hasOverride)
  const busy = saving || removingOverride

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
        <PolicyFeedback
          error={error}
          success={success}
          onClearError={() => section.setError("")}
          onClearSuccess={() => section.setSuccess("")}
        />

        <PolicyScopeSelect value={scopeLodgeId} onChange={setScopeLodgeId} />

        {!scopeKnown ? (
          <Card>
            <CardHeader>
              <CardTitle>
                Could not load the policy for{" "}
                {scopeIsLodge ? (scopeLodgeName ?? "this lodge") : "the club"}
              </CardTitle>
              <CardDescription>
                No editor is shown, because we do not know what is stored for
                this scope. The rules that were on screen a moment ago belong to
                a different scope, so editing or removing them from here would
                change the wrong thing. Switch scope again, or reload the page —
                the editor returns as soon as the policy loads.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : null}

        {scopeIsLodge && scopeKnown && !hasOverride ? (
          <Card>
            <CardHeader>
              <CardTitle>{scopeLodgeName ?? "Lodge"} uses the club-wide rules</CardTitle>
              <CardDescription>
                No override exists for this lodge, so cancellations here follow
                the club-wide policy. An override replaces the club-wide rules
                entirely for this lodge.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={() => void handleCreateOverride()}>
                Create override for this lodge
              </ViewOnlyActionButton>
            </CardContent>
          </Card>
        ) : null}

        {showEditor ? (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>
                  {scopeIsLodge
                    ? `${scopeLodgeName ?? "Lodge"} Override`
                    : "Default Policy"}
                </CardTitle>
                <CardDescription>
                  {scopeIsLodge
                    ? "These rules replace the club-wide rules for bookings at this lodge."
                    : "These rules apply to all bookings unless a date-specific period overrides them."}
                </CardDescription>
              </div>
              {!editing && (
                <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={section.startEditing}>
                  Edit
                </ViewOnlyActionButton>
              )}
            </CardHeader>
            <CardContent className="space-y-6">
              {!scopeIsLodge ? (
                <div className="space-y-4 max-w-md">
                  <div className="flex items-start gap-3 rounded-md border p-3">
                    <Checkbox
                      id="nonMemberHoldEnabled"
                      checked={draft.holdEnabled}
                      disabled={!editing}
                      onCheckedChange={(v) => section.setDraft({ holdEnabled: v === true })}
                    />
                    <div className="space-y-1">
                      <Label htmlFor="nonMemberHoldEnabled">Members First booking policy</Label>
                      <p className="text-xs text-muted-foreground">
                        When enabled, non-member guests outside the threshold are held provisionally.
                        When disabled, mixed member and non-member bookings proceed as First Paid, First In.
                      </p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="holdDays">Non-member confirmation threshold</Label>
                    <div className="flex items-center space-x-2">
                      <Input
                        id="holdDays"
                        type="number"
                        min="1"
                        max="365"
                        value={draft.holdDays}
                        onChange={(e) =>
                          section.setDraft({ holdDays: parseInt(e.target.value) || 7 })
                        }
                        className={`w-20 ${!editing || !draft.holdEnabled ? "bg-slate-50 text-slate-700" : ""}`}
                        disabled={!editing || !draft.holdEnabled}
                      />
                      <span className="text-sm text-muted-foreground">days before check-in</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {draft.holdEnabled
                        ? "Non-member bookings are held as pending until this many days before check-in, then confirmed automatically."
                        : "The threshold is retained but inactive while First Paid, First In is selected."}
                    </p>
                  </div>
                </div>
              ) : null}

              {!scopeIsLodge && lodges.length > 1 ? (
                <div className="space-y-2 max-w-md">
                  <Label htmlFor="waitlistOrder">Cross-lodge waitlist queue order</Label>
                  <select
                    id="waitlistOrder"
                    value={draft.waitlistOrder}
                    onChange={(e) =>
                      section.setDraft({
                        waitlistOrder: e.target.value as WaitlistCrossLodgeOrder,
                      })
                    }
                    disabled={!editing}
                    className={`w-full rounded-md border border-input px-3 py-2 text-sm ${!editing ? "bg-slate-50 text-slate-700" : "bg-background"}`}
                  >
                    <option value="OWN_LODGE_FIRST">
                      Own lodge first — a lodge&apos;s own waitlist is served before cross-lodge opt-ins
                    </option>
                    <option value="MERGED">
                      Merged — everyone eligible is ranked purely by when they joined
                    </option>
                  </select>
                  <p className="text-xs text-muted-foreground">
                    When a spot frees up at a lodge, this decides whether members
                    waitlisted at that lodge are always served before members from
                    another lodge&apos;s waitlist who opted in to accept it.
                  </p>
                </div>
              ) : null}

              <div>
                <Label className="text-base font-semibold">Cancellation Refund Rules</Label>
                <p className="text-sm text-muted-foreground mb-3">
                  The first matching rule (highest days threshold) applies.
                </p>
                <CancellationRulesEditor
                  rules={draft.rules}
                  onChange={(rules) => section.setDraft({ rules })}
                  disabled={!editing}
                />
              </div>

              <div>
                <Label className="text-sm font-semibold">Preview</Label>
                <PolicyPreview rules={draft.rules} />
              </div>

              {editing && (
                <div className="flex flex-wrap gap-3">
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    onClick={() => void section.save()}
                    disabled={busy || !dirty}
                  >
                    {saving
                      ? "Saving..."
                      : scopeIsLodge
                        ? "Save Lodge Override"
                        : "Save Default Policy"}
                  </ViewOnlyActionButton>
                  <Button variant="outline" onClick={handleCancelDefaults} disabled={busy}>
                    Cancel
                  </Button>
                </div>
              )}
              {scopeIsLodge && hasOverride && !editing ? (
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  variant="outline"
                  onClick={() => void handleRemoveOverride()}
                  disabled={busy}
                >
                  Remove override (use club-wide rules)
                </ViewOnlyActionButton>
              ) : null}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
