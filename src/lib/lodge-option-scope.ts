/**
 * Total client-side state for a lodge selector whose downstream work must not
 * guess a lodge (#2701/#2887). Client-safe: no React, Next or Prisma imports.
 */
export type SettledLodgeOptionScope =
  | { kind: "loading" }
  | { kind: "failed" }
  | { kind: "forbidden" }
  | { kind: "empty" }
  | { kind: "all" }
  | { kind: "lodge"; lodgeId: string; lodgeName: string }

type LodgeOption = { id: string; name: string }

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
    #2887 review (F1): the DELIBERATE club-wide answer is decided before the
    list's failure modes, and that ordering is load-bearing.

    A caller that pins `selectedLodgeId` to its own `explicitAllLodgesValue` is
    saying "this surface is club-wide by construction" — promo codes and work
    parties are the two, and both hard-code it. Their answer cannot depend on
    the lodge list, so a `failed`, `forbidden` or `empty` list must not take it
    away from them.

    Testing `forbidden` first did exactly that. `GET /api/admin/lodges` needs
    `lodge:view`, and two shipped presets — `ADMIN_MEMBERSHIP` and
    `FINANCE_ADMIN` — have no `lodge` entry at all, so their 403 is PERMANENT
    and the retry can only 403 again. A `FINANCE_ADMIN` clicking Promo Codes in
    the sidebar got a header, no Add button, no promo codes and an alert saying
    nothing had failed. Before this branch that click listed every promo code.

    `loading` still wins, because "not yet" is not an outcome and resolves on
    its own in a moment.
  */
  if (
    input.explicitAllLodgesValue !== undefined &&
    input.selectedLodgeId === input.explicitAllLodgesValue
  ) {
    return { kind: "all" }
  }

  if (input.failed) return { kind: "failed" }
  if (input.forbidden) return { kind: "forbidden" }
  if (input.lodges.length === 0) return { kind: "empty" }
  const lodge = input.lodges.find(
    (option) => option.id === input.selectedLodgeId,
  )
  return lodge
    ? { kind: "lodge", lodgeId: lodge.id, lodgeName: lodge.name }
    : { kind: "loading" }
}

export function settledLodgeId(
  scope: SettledLodgeOptionScope,
): string | null {
  return scope.kind === "lodge" ? scope.lodgeId : null
}
