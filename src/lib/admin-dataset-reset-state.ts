import { format, subMonths } from "date-fns"

export const PAYMENT_DATASET_QUERY_KEYS = [
  "status",
  "source",
  "xeroState",
  "settlement",
  "lastUpdatedFrom",
  "lastUpdatedTo",
  "checkInFrom",
  "checkInTo",
  "search",
  "amountExact",
  "amountMin",
  "amountMax",
  "sortBy",
  "sortDir",
  "page",
] as const

export const SUBSCRIPTION_DATASET_QUERY_KEYS = [
  "status",
  "ageTier",
  "xeroContactGroup",
  "sortBy",
  "sortDir",
  "page",
] as const

export function withoutDatasetQueryKeys(
  currentSearch: string,
  keys: readonly string[],
): URLSearchParams {
  const params = new URLSearchParams(currentSearch)
  for (const key of keys) params.delete(key)
  return params
}

export function getPaymentsDatasetDefaults(clubToday: string) {
  const [year, month, day] = clubToday.split("-").map(Number)
  return {
    lastUpdatedFrom: format(
      subMonths(new Date(year, month - 1, day), 3),
      "yyyy-MM-dd",
    ),
    lastUpdatedTo: clubToday,
  }
}

export function resetPaymentsDatasetSearchParams(
  currentSearch: string,
  clubToday: string,
): URLSearchParams {
  const params = withoutDatasetQueryKeys(
    currentSearch,
    PAYMENT_DATASET_QUERY_KEYS,
  )
  const defaults = getPaymentsDatasetDefaults(clubToday)
  params.set("lastUpdatedFrom", defaults.lastUpdatedFrom)
  params.set("lastUpdatedTo", defaults.lastUpdatedTo)
  return params
}

export function resetSubscriptionsDatasetSearchParams(
  currentSearch: string,
): URLSearchParams {
  return withoutDatasetQueryKeys(currentSearch, SUBSCRIPTION_DATASET_QUERY_KEYS)
}
