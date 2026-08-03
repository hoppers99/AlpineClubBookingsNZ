/**
 * `exceptions` (#2526) is the Booking Officer's booking-policy exception queue —
 * a distinct tab from `changes` because the two decide different things: a
 * locked-period change request is an acknowledgement an admin then applies by
 * hand, while approving a policy exception EXECUTES the reviewed proposal.
 */
export type BookingRequestsTab =
  | "approvals"
  | "changes"
  | "exceptions"
  | "public";

type SearchParamValue = string | string[] | undefined;

export function buildBookingRequestsHref(
  tab: BookingRequestsTab,
  searchParams: Record<string, SearchParamValue> = {},
) {
  const params = new URLSearchParams({ tab });

  for (const [key, value] of Object.entries(searchParams)) {
    if (key === "tab" || value == null) {
      continue;
    }

    if (Array.isArray(value)) {
      value.forEach((item) => params.append(key, item));
    } else {
      params.set(key, value);
    }
  }

  return `/admin/booking-requests?${params.toString()}`;
}
