"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { FieldHint, useFieldHint } from "@/components/ui/field-hint"
import { Label } from "@/components/ui/label"
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access"
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state"
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action"
import { PolicyFeedback } from "./policy-feedback"
import { PolicyScopeSelect, usePolicyScopeLodgeName } from "./policy-scope-select"
import type { AdultMemberHostingPolicy } from "./types"

const ENDPOINT = "/api/admin/booking-policies/adult-member-hosting"

/**
 * The scope a snapshot was loaded FOR. Club-wide scope is `null`, so `null`
 * cannot double as "unknown" — the same sentinel as the minimum-stay and
 * cancellation sections, and for the same reason: after a failed switch to a
 * lodge, a card that kept the previous scope's values on screen would let an
 * admin save one lodge's decision onto another's.
 */
const UNLOADED_SCOPE = "__unloaded__"

interface HostingDraft {
  mode: "INHERIT" | "DISABLED" | "ADMIN_REVIEW_REQUIRED"
  /** Empty until an admin chooses: new policies get no automatic mode (D-R6). */
  capacityMode: "" | "HOLD" | "NO_HOLD"
  /** CAS token; absent (null) means "no row is stored for this scope yet". */
  version: number | null
  /** Whether a row is actually persisted, as reported by the GET (#2142). */
  configured: boolean
}

function toDraft(policy: AdultMemberHostingPolicy): HostingDraft {
  return {
    mode: policy.mode,
    capacityMode: policy.capacityMode ?? "",
    version: policy.configured ? policy.version : null,
    configured: policy.configured,
  }
}

/** Accept only a complete server row that is safe to render and re-seed. */
function parsePolicy(value: unknown): AdultMemberHostingPolicy | null {
  if (!value || typeof value !== "object") return null
  const row = value as Record<string, unknown>
  if (
    row.mode !== "INHERIT" &&
    row.mode !== "DISABLED" &&
    row.mode !== "ADMIN_REVIEW_REQUIRED"
  ) {
    return null
  }
  if (
    row.capacityMode !== null &&
    row.capacityMode !== "HOLD" &&
    row.capacityMode !== "NO_HOLD"
  ) {
    return null
  }
  if (!Number.isInteger(row.version)) return null
  if (typeof row.configured !== "boolean") return null
  return row as unknown as AdultMemberHostingPolicy
}

async function responseMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  const body = (await response.json().catch(() => null)) as
    | { error?: unknown }
    | null
  return typeof body?.error === "string" ? body.error : fallback
}

export function AdultMemberHostingSection() {
  // Booking-policy config gates on the bookings area, whose write route enforces
  // bookings:edit; a bookings:view admin sees this read-only (#1940).
  const canEdit = useAdminAreaEditAccess("bookings")
  const [scopeLodgeId, setScopeLodgeId] = useState<string | null>(null)
  const scopeLodgeName = usePolicyScopeLodgeName(scopeLodgeId)
  const [loadedScope, setLoadedScope] = useState<string | null>(UNLOADED_SCOPE)
  const scopeRef = useRef(scopeLodgeId)
  const modeHint = useFieldHint()
  const capacityHint = useFieldHint()
  /**
   * The hook's `reload`, reachable from inside its own `save` callback.
   *
   * `save` is declared in the options object that CREATES the hook state, so it
   * cannot close over `section` directly. A ref refreshed after each commit is
   * the smallest honest way to let a 409 pull a fresh authoritative row.
   */
  const reloadRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    scopeRef.current = scopeLodgeId
  }, [scopeLodgeId])

  const section = useSectionEditState<HostingDraft>({
    load: async (signal) => {
      const scope = scopeRef.current
      const res = await fetch(
        scope ? `${ENDPOINT}?lodgeId=${encodeURIComponent(scope)}` : ENDPOINT,
        { signal },
      )
      if (!res.ok) {
        setLoadedScope(UNLOADED_SCOPE)
        throw new Error("Failed to load the adult-member hosting policy")
      }
      const policy = parsePolicy(await res.json().catch(() => null))
      if (!policy) {
        setLoadedScope(UNLOADED_SCOPE)
        throw new Error("Failed to read the adult-member hosting policy")
      }
      setLoadedScope(scope)
      return toDraft(policy)
    },
    save: async (draft) => {
      const scope = scopeRef.current
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: draft.mode,
          capacityMode: draft.capacityMode,
          // Only sent when a row is stored: absent means "I believe there is
          // nothing here yet", which the route checks rather than assumes.
          ...(draft.version !== null ? { version: draft.version } : {}),
          ...(scope ? { lodgeId: scope } : {}),
        }),
      })
      if (!res.ok) {
        if (res.status === 403) throw new ForbiddenSaveError()
        const message = await responseMessage(res, "Failed to save")
        if (res.status === 409) {
          // Somebody else moved the row. Drop this scope back to UNKNOWN so no
          // further write can be sent from a stale token, then pull the current
          // one. `reload` clears both messages, so the refusal is re-set after.
          setLoadedScope(UNLOADED_SCOPE)
          await reloadRef.current()
        }
        throw new Error(message)
      }
      const policy = parsePolicy(await res.json().catch(() => null))
      if (!policy) throw new Error("Saved, but the response could not be read")
      return toDraft(policy)
    },
    successMessage: "Adult-member hosting policy saved",
    // First save exception (#2142): until a row is persisted there is nothing
    // for the draft to be unchanged FROM — the GET synthesised it — so a first
    // save can store the club's choice even when it matches the built-in
    // default. Afterwards this is the plain field comparison again (#2143).
    isDirty: (draft, saved) =>
      !draft.configured ||
      draft.mode !== saved.mode ||
      draft.capacityMode !== saved.capacityMode,
    // Capacity mode is required on every write, so a first save cannot happen
    // until the admin has actually chosen one (D-R6).
    isValid: (draft) => draft.capacityMode !== "",
  })

  const { draft, editing, saving, dirty, valid, error, success } = section

  useEffect(() => {
    reloadRef.current = section.reload
  })

  // Reload when the scope CHANGES; the keyed snapshot travels with its scope.
  // The hook already loads once on mount, so the mount run is skipped rather
  // than fetching the club-wide row twice on first paint.
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    setLoadedScope(UNLOADED_SCOPE)
    void reloadRef.current()
  }, [scopeLodgeId])

  const retryLoad = useCallback(() => {
    void reloadRef.current()
  }, [])

  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the adult-member hosting policy but cannot change
      it. Bookings edit access is required.
    </AdminViewOnlySectionBanner>
  )

  // The snapshot is authoritative only for the scope it was loaded for.
  const scopeKnown = loadedScope === scopeLodgeId

  return (
    <div>
      {viewOnlyBanner}
      <PolicyFeedback
        error={error}
        success={success}
        onClearError={() => section.setError("")}
        onClearSuccess={() => section.setSuccess("")}
      />
      <div className="space-y-6">
        <PolicyScopeSelect
          value={scopeLodgeId}
          onChange={setScopeLodgeId}
          id="adult-member-hosting-scope"
        />

        {section.loading ? (
          <div className="text-center py-8">Loading...</div>
        ) : null}

        {!section.loading && (!scopeKnown || !draft) ? (
          <Card>
            <CardHeader>
              <CardTitle>
                Could not load the adult-member hosting policy for{" "}
                {scopeLodgeName ?? "the club"}
              </CardTitle>
              <CardDescription>
                Nothing is shown, because we do not know what is stored here. The
                settings that were on screen a moment ago belong to a different
                scope, so saving from here would change the wrong one. Try again
                below.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="outline" onClick={retryLoad}>
                Try again
              </Button>
            </CardContent>
          </Card>
        ) : null}

        {!section.loading && scopeKnown && draft ? (
          <Card>
            <CardHeader className="flex flex-row items-center justify-between">
              <div>
                <CardTitle>
                  {scopeLodgeName
                    ? `Adult Member Hosting — ${scopeLodgeName}`
                    : "Adult Member Hosting"}
                </CardTitle>
                <CardDescription>
                  Ask that an adult member is staying on the same booking as any
                  non-member guest, on every night that guest is there. Bookings
                  that do not meet it are still made — they are sent to an admin
                  to look at, and the review clears itself if an adult member is
                  added later.
                  {scopeLodgeName ? (
                    <>
                      {" "}
                      This setting belongs to {scopeLodgeName}. Leave it on
                      &ldquo;Use the club-wide setting&rdquo; for the lodge to
                      follow whatever the club decides.
                    </>
                  ) : null}
                </CardDescription>
              </div>
              {!editing && (
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  variant="outline"
                  size="sm"
                  onClick={section.startEditing}
                >
                  Edit
                </ViewOnlyActionButton>
              )}
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 max-w-md">
                <Label htmlFor="hostingMode">
                  Non-member guests without an adult member
                </Label>
                <select
                  id="hostingMode"
                  value={draft.mode}
                  disabled={!editing}
                  onChange={(event) =>
                    section.setDraft({
                      mode: event.target.value as HostingDraft["mode"],
                    })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm disabled:bg-muted disabled:text-muted-foreground"
                  {...modeHint.fieldProps}
                >
                  {scopeLodgeId ? (
                    <option value="INHERIT">Use the club-wide setting</option>
                  ) : null}
                  <option value="DISABLED">
                    Allowed — no adult member needed
                  </option>
                  <option value="ADMIN_REVIEW_REQUIRED">
                    Send the booking to an admin to review
                  </option>
                </select>
                <FieldHint {...modeHint.hintProps}>
                  A qualifying adult member has to be on the booking as a guest
                  in their own right. Owning the booking is not enough, and
                  child or youth members do not count.
                </FieldHint>
              </div>

              <div className="space-y-2 max-w-md">
                <Label htmlFor="hostingCapacityMode">
                  Exception capacity handling
                </Label>
                <select
                  id="hostingCapacityMode"
                  value={draft.capacityMode}
                  disabled={!editing}
                  onChange={(event) =>
                    section.setDraft({
                      capacityMode: event.target
                        .value as HostingDraft["capacityMode"],
                    })
                  }
                  className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm disabled:bg-muted disabled:text-muted-foreground"
                  {...capacityHint.fieldProps}
                >
                  <option value="" disabled>
                    Select how capacity is handled
                  </option>
                  <option value="HOLD">
                    Hold requested capacity while it waits
                  </option>
                  <option value="NO_HOLD">
                    Do not hold capacity until approval
                  </option>
                </select>
                <FieldHint {...capacityHint.hintProps}>
                  This applies when a booking needs an approved exception to this
                  rule. There is no automatic choice, so pick one even if the
                  requirement is off today — it is what the club will fall back
                  on the moment it is turned on. A hold is not open-ended: it
                  lasts until the request is decided or its deadline passes —
                  7 days after it is raised, never past the start of the first
                  night held, and never less than 24 hours — after which the beds
                  return to the pool and the request is marked Expired.
                </FieldHint>
              </div>

              <p className="text-sm text-muted-foreground">
                {draft.configured
                  ? `Revision ${draft.version}.`
                  : "Not configured yet — the built-in default is shown."}
              </p>

              {editing && (
                <div className="flex space-x-3">
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    onClick={() => void section.save()}
                    disabled={!dirty || !valid || saving}
                  >
                    {saving ? "Saving..." : "Save Hosting Policy"}
                  </ViewOnlyActionButton>
                  <Button
                    variant="outline"
                    onClick={section.cancelEditing}
                    disabled={saving}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </div>
  )
}
