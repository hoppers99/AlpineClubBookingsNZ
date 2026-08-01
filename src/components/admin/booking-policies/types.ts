import type { NormalizedCancellationRule } from "@/lib/cancellation-rules"

export const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const

export type PolicyRule = NormalizedCancellationRule & { id?: string }

export interface MinStayPolicy {
  id: string
  name: string
  startDate: string
  endDate: string
  triggerDays: number[]
  minimumNights: number
  capacityMode: "HOLD" | "NO_HOLD"
  version: number
  active: boolean
}

/**
 * One scope's adult-member hosting setting (#2364).
 *
 * `configured: false` is the SYNTHESISED body the GET returns for a scope with
 * no stored row: `version` is then 0 and `capacityMode` null, because a new
 * policy has no automatic capacity choice (epic decision D-R6).
 */
export interface AdultMemberHostingPolicy {
  scopeKey: string
  lodgeId: string | null
  mode: "INHERIT" | "DISABLED" | "ADMIN_REVIEW_REQUIRED"
  capacityMode: "HOLD" | "NO_HOLD" | null
  version: number
  configured: boolean
}

export interface BookingPeriod {
  id: string
  name: string
  startDate: string
  endDate: string
  nonMemberHoldEnabled: boolean
  nonMemberHoldDays: number
  cancellationRules: PolicyRule[]
  active: boolean
}
