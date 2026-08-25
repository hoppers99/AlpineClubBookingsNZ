/**
 * Total client-side state for a lodge selector whose downstream work must not
 * guess a lodge (#2701/#2887). Client-safe: no React, Next or Prisma imports.
 */
export type SettledLodgeOptionScope =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "forbidden" }
  | { kind: "empty" }
  | { kind: "closed" }
  | { kind: "all" }
  | { kind: "lodge"; lodgeId: string; lodgeName: string }

/**
 * `active` is absent on every list except the CONFIGURATION scope of the
 * lodge-options hook (see `lodge-select.tsx`'s `LodgeOption` doc); an absent
 * value reads as open, matching that hook's own contract.
 */
type LodgeOption = { id: string; name: string; active?: boolean }

export function deriveSettledLodgeOptionScope(input: {
  lodges: readonly LodgeOption[]
  selectedLodgeId: string | null
  loading: boolean
  failed: boolean
  forbidden: boolean
  /** Sentinel for a surface that deliberately supports a club-wide view. */
  explicitAllLodgesValue?: string
}): SettledLodgeOptionScope {
  if (input.loading) return { kind: "loading" }

  /*
    A list OUTCOME always wins over the deliberate club-wide answer (#2887
    review). This order was briefly reversed and the reversal is reverted here;
    the reasoning is worth keeping because the reversal looked obviously right.

    Promo codes and work parties pin `selectedLodgeId` to their own
    `explicitAllLodgesValue`, so they are club-wide by construction and their
    CONTENT does not depend on the lodge list. The inference was that a
    `failed`, `forbidden` or `empty` list should therefore not blank them. It is
    the wrong inference, because those pages need the list for a second thing:
    both gate their lodge-RESTRICTION control on `lodges.length > 1`, and
    `useLodgeOptions` sets `lodges: []` on a 403 AND on any other failure
    (`lodge-select.tsx`). Returning `all` there unlocks the create while the
    control that scopes it is hidden, so:

      - a promo code saves with `lodgeIds` omitted entirely — redeemable at
        every lodge, when the admin meant one;
      - a work party saves `lodgeId: null` — an event at every lodge, which is
        the exact defect #2701 fixed on that page.

    That is worse than the blank page it was meant to cure: a blank page refuses
    to act, and this acts wrongly and silently. Restricting the reversal to
    `forbidden` alone does not help either, because `forbidden` empties the list
    by the same code path.

    The blank page the reversal targeted was REAL, and #2925 fixed it AT THE
    ROUTE, which is where one gate serves every consumer. `GET
    /api/admin/lodges` now admits any admitted admin (`overview:view`) and
    narrows its payload to `{ id, name, slug, active }` for a caller without
    `lodge:view`, so `ADMIN_MEMBERSHIP` and `FINANCE_ADMIN` get a real list and
    those surfaces no longer stop.

    This ordering still stands, and must not be re-reversed. `forbidden` remains
    reachable — a custom role can hold `bookings: "view"` with `overview: "none"`
    — and `failed` always was, so returning `all` from either state would still
    unlock a create while the control that scopes it is hidden, which is the
    silently mis-scoped write described above.

    `empty` stays ahead of `all` deliberately. A club with no active lodge can
    scope nothing, so offering an unrestricted create there is vacuous at best;
    the empty notice is the honest answer.
  */
  if (input.failed) return { kind: "failed" }
  if (input.forbidden) return { kind: "forbidden" }
  if (input.lodges.length === 0) return { kind: "empty" }
  if (
    input.explicitAllLodgesValue !== undefined &&
    input.selectedLodgeId === input.explicitAllLodgesValue
  ) {
    return { kind: "all" }
  }
  const lodge = input.lodges.find(
    (option) => option.id === input.selectedLodgeId,
  )
  if (lodge) {
    return { kind: "lodge", lodgeId: lodge.id, lodgeName: lodge.name }
  }
  /*
    No value matches a row. If at least one lodge in the list is OPEN, this is
    transient: `LodgeSelect`'s own effect (ADR-002) is about to auto-select
    the first open lodge and drive a fresh render with `selectedLodgeId` set,
    so "loading" here means "about to settle", not "stuck".

    But when every lodge in the list is closed — reachable only on a
    CONFIGURATION list (#221), and only when nothing has named one of them —
    `LodgeSelect` renders nothing and calls no `onChange`: the sole-lodge rule
    counts OPEN lodges only, so `open[0]` is `undefined` and there is nothing
    left to auto-select. Reporting "loading" forever there hides a state the
    operator can act on (open a lodge) behind a state that promises to
    resolve itself and never does.
  */
  const anyOpen = input.lodges.some((option) => option.active !== false)
  return anyOpen ? { kind: "loading" } : { kind: "closed" }
}

export function settledLodgeId(
  scope: SettledLodgeOptionScope,
): string | null {
  return scope.kind === "lodge" ? scope.lodgeId : null
}
