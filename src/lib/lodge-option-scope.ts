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
  return lodge
    ? { kind: "lodge", lodgeId: lodge.id, lodgeName: lodge.name }
    : { kind: "loading" }
}

export function settledLodgeId(
  scope: SettledLodgeOptionScope,
): string | null {
  return scope.kind === "lodge" ? scope.lodgeId : null
}

