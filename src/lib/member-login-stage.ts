/**
 * Login-journey stage for an admin member row (issue #1444).
 *
 * The admin members list used to say the same thing twice — a "No Login" badge
 * in the Access column and a "Non-Login"/"Can Login" badge in a separate Login
 * column — while hiding where a login-enabled member sat in the invite journey.
 * This module is the single source of truth for that journey so the Access
 * column, the row action button, and the list filter can never disagree.
 *
 * The four stages map 1:1 onto {@link getMemberPasswordActionKind}:
 *   - no-login    → kind null            (canLogin off)
 *   - not-invited → "invite"             (login on, no invite/password yet)
 *   - invited     → "resend-invite"      (pending unexpired invite token)
 *   - can-login   → "reset-password"     (account setup complete)
 *
 * Kept in a non-"use client" module (unlike the action button that re-exports
 * it) so both server WHERE mirroring and plain unit tests can import it.
 */

export interface MemberPasswordActionState {
  canLogin: boolean
  hasCompletedAccountSetup: boolean
  pendingInviteExpiresAt: string | Date | null
}

export type MemberPasswordActionKind = "invite" | "resend-invite" | "reset-password"

export function getMemberPasswordActionKind(
  member: MemberPasswordActionState
): MemberPasswordActionKind | null {
  if (!member.canLogin) return null
  if (member.hasCompletedAccountSetup) return "reset-password"
  return member.pendingInviteExpiresAt ? "resend-invite" : "invite"
}

export type MemberLoginStage =
  | "no-login"
  | "not-invited"
  | "invited"
  | "can-login"

/** Display labels, declared in the order the filter select lists them. */
export const LOGIN_STAGE_LABELS: Record<MemberLoginStage, string> = {
  "no-login": "No login",
  "not-invited": "Not invited",
  invited: "Invited",
  "can-login": "Can log in",
}

/**
 * Semantic tone for each login-journey stage.
 *
 * These are deliberately about account readiness, not the member's role:
 * no login is informationally neutral, an enabled account that has not been
 * invited needs attention, an outstanding invitation is in progress, and a
 * completed account is ready. Members and Subscriptions both consume this map
 * so the same person cannot appear with different Access meaning or colour.
 */
export const LOGIN_STAGE_TONES: Record<
  MemberLoginStage,
  "neutral" | "warning" | "info" | "success"
> = {
  "no-login": "neutral",
  "not-invited": "warning",
  invited: "info",
  "can-login": "success",
}

/**
 * The `inviteStatus` query-param value that filters to each stage. The three
 * login-on values are the existing action kinds (kept for least churn); the
 * no-login value is new for #1444.
 */
export const LOGIN_STAGE_FILTER_VALUES: Record<MemberLoginStage, string> = {
  "no-login": "no-login",
  "not-invited": "invite",
  invited: "resend-invite",
  "can-login": "reset-password",
}

/**
 * Operator-facing sort order for the Access column. Keep this beside the
 * labels and derivation so the server query cannot silently substitute a
 * hidden database field (such as member role) for the status users see.
 */
export const LOGIN_STAGE_SORT_ORDER: readonly MemberLoginStage[] = [
  "no-login",
  "not-invited",
  "invited",
  "can-login",
]

export function getMemberLoginStageSortRank(
  member: MemberPasswordActionState,
): number {
  return LOGIN_STAGE_SORT_ORDER.indexOf(getMemberLoginStage(member))
}

/**
 * The member's single current login-journey stage, derived from the same
 * {@link getMemberPasswordActionKind} the row action button uses so the column
 * and the button can never disagree.
 */
export function getMemberLoginStage(
  member: MemberPasswordActionState
): MemberLoginStage {
  const kind = getMemberPasswordActionKind(member)
  if (kind === null) return "no-login"
  if (kind === "invite") return "not-invited"
  if (kind === "resend-invite") return "invited"
  return "can-login"
}
