"use client"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { LodgeOptionsUnavailableNotice } from "@/components/admin/lodge-options-status"
import { useLodgeOptions } from "@/components/lodge-select"

const CLUB_WIDE = "__club_wide__"

// Scope selector for the booking-policy editors (ADR-001 resolved question
// 3): policies are club-wide by default with per-lodge override sets that
// REPLACE (never merge with) the club-wide rules. Unlike LodgeSelect, the
// default option here is explicitly "club-wide", not a lodge. Renders
// nothing while fewer than two lodges exist (ADR-002 presentation rule), so
// single-lodge clubs only ever edit the club-wide rules.
export function PolicyScopeSelect({
  value,
  onChange,
  id = "policy-scope-select",
}: {
  value: string | null
  onChange: (lodgeId: string | null) => void
  id?: string
}) {
  const { lodges, loading, failed, forbidden, reload } = useLodgeOptions("admin")

  if (loading) {
    return null
  }

  /*
    #2701: this control had no error surface at all — a failed lodge list gave
    an empty `lodges`, which is the same shape as a single-lodge club, so it
    returned null and the section silently became "club-wide rules" with no way
    to reach a lodge's overrides. Club-wide rules are not a harmless default
    here: they apply to every lodge that has no override of its own, so an admin
    who meant to change one lodge changes all of them, and the control that
    would have said so is not on the page.

    Rendered INSTEAD of null, never alongside the select, so a section that has
    a scope control always has either the control or the reason it is missing.
  */
  if (failed || forbidden) {
    return (
      <LodgeOptionsUnavailableNotice
        failed={failed}
        forbidden={forbidden}
        onRetry={reload}
        what="per-lodge rule overrides"
        className="max-w-xl"
      />
    )
  }

  if (lodges.length < 2) {
    return null
  }

  return (
    <div className="max-w-xs space-y-2">
      <Label htmlFor={id}>Rules for</Label>
      <Select
        value={value ?? CLUB_WIDE}
        onValueChange={(next) => onChange(next === CLUB_WIDE ? null : next)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CLUB_WIDE}>Club-wide rules (default)</SelectItem>
          {lodges.map((lodge) => (
            <SelectItem key={lodge.id} value={lodge.id}>
              {lodge.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

export function usePolicyScopeLodgeName(lodgeId: string | null): string | null {
  const { lodges } = useLodgeOptions("admin")
  if (!lodgeId) return null
  return lodges.find((lodge) => lodge.id === lodgeId)?.name ?? null
}
