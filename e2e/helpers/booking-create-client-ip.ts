import type { APIRequestContext, APIResponse, Page } from "@playwright/test";

/**
 * Closed census of E2E tests that submit `POST /api/bookings`.
 *
 * Every current entry is an ordinary journey or setup call, not a limiter test:
 * it therefore receives one deterministic private-IP bucket per test attempt.
 * Requests still pass through the real production limiter. If a future spec is
 * intentionally about sharing or exhausting that limiter, classify it here as
 * `intentional-limiter` and do not call {@link bookingCreateIsolation} for it.
 */
export const E2E_BOOKING_CREATE_CENSUS = [
  {
    key: "admin-override-seed",
    file: "e2e/admin-override-dates.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "admin-retroactive-record",
    file: "e2e/admin-retroactive-booking.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "admin-retroactive-member-rejection",
    file: "e2e/admin-retroactive-booking.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "adult-hosting-refusal",
    file: "e2e/adult-member-hosting.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "adult-hosting-cross-booking",
    file: "e2e/adult-member-hosting.spec.ts",
    transport: "api",
    classification: "isolated-setup",
    requestsPerAttempt: 2,
  },
  {
    key: "booking-payment-pending",
    file: "e2e/booking.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "booking-create-shared-store-proof",
    file: "e2e/booking-create-rate-isolation.spec.ts",
    transport: "api",
    classification: "isolated-setup",
    requestsPerAttempt: 3,
  },
  {
    key: "double-bed-capacity",
    file: "e2e/double-bed-sharing.spec.ts",
    transport: "api",
    classification: "isolated-setup",
    requestsPerAttempt: 2,
  },
  {
    key: "double-bed-allocation",
    file: "e2e/double-bed-sharing.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "dual-hat-member-create",
    file: "e2e/dual-hat-booking.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "dual-hat-officer-draft",
    file: "e2e/dual-hat-booking.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "member-exception-compliant",
    file: "e2e/member-policy-exception-requests.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "member-exception-minimum-refusal",
    file: "e2e/member-policy-exception-requests.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "member-exception-replacement",
    file: "e2e/member-policy-exception-requests.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "member-exception-approval",
    file: "e2e/member-policy-exception-requests.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "member-guest-consent-approve",
    file: "e2e/member-guest-consent.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "member-guest-consent-decline",
    file: "e2e/member-guest-consent.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "multi-lodge-member-edit",
    file: "e2e/multi-lodge/member-guest-edit-path.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "multi-lodge-officer-edit",
    file: "e2e/multi-lodge/member-guest-edit-path.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
  {
    key: "on-behalf-inline-owner",
    file: "e2e/book-on-behalf-nonmember.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "on-behalf-existing-owner",
    file: "e2e/book-on-behalf-nonmember.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "on-behalf-walk-in-owner",
    file: "e2e/book-on-behalf-nonmember.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "stripe-success",
    file: "e2e/stripe-payment.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "stripe-decline",
    file: "e2e/stripe-payment.spec.ts",
    transport: "browser",
    classification: "isolated-setup",
  },
  {
    key: "waitlist-placement",
    file: "e2e/waitlist.spec.ts",
    transport: "api",
    classification: "isolated-setup",
    requestsPerAttempt: 2,
  },
  {
    key: "whole-lodge-held-anchor",
    file: "e2e/whole-lodge-request.spec.ts",
    transport: "api",
    classification: "isolated-setup",
  },
] as const satisfies ReadonlyArray<{
  key: string;
  file: string;
  transport: "api" | "browser";
  classification: "isolated-setup" | "intentional-limiter";
  requestsPerAttempt?: number;
}>;

export type BookingCreateIsolationKey =
  (typeof E2E_BOOKING_CREATE_CENSUS)[number]["key"];

export type BookingCreateIsolation = Readonly<{
  key: BookingCreateIsolationKey;
  retry: number;
  clientIp: string;
  headers: Readonly<Record<"x-forwarded-for", string>>;
}>;

/**
 * Return the one private booking-create bucket allocated to a logical spec
 * attempt. The third octet is the registered census slot; the fourth is the
 * Playwright retry number plus one. That makes repeated calls within an attempt
 * stable while separating every registered spec and retry without a hash
 * collision.
 *
 * `10.240.0.0/16` is deliberately disjoint from the login helper's
 * `10.99.0.0/16` and the whole-lodge submission worlds' `10.77.1.0/24`.
 */
export function bookingCreateIsolation(
  key: BookingCreateIsolationKey,
  retry: number,
): BookingCreateIsolation {
  if (!Number.isSafeInteger(retry) || retry < 0 || retry > 253) {
    throw new RangeError(`booking-create retry must be an integer from 0 to 253; got ${retry}`);
  }

  const slot = E2E_BOOKING_CREATE_CENSUS.findIndex((entry) => entry.key === key) + 1;
  if (slot === 0) {
    throw new Error(`unregistered E2E booking-create isolation key: ${key}`);
  }

  const clientIp = `10.240.${slot}.${retry + 1}`;
  return Object.freeze({
    key,
    retry,
    clientIp,
    headers: Object.freeze({ "x-forwarded-for": clientIp }),
  });
}

type BookingCreatePostOptions = NonNullable<
  Parameters<APIRequestContext["post"]>[1]
>;

/**
 * Submit one direct E2E booking-create request through its registered bucket.
 *
 * Keeping the exact route literal in this one helper lets the executable census
 * reject every raw `APIRequestContext.post` call in a spec, including a call
 * whose path is hidden behind a simple const alias. Per-request headers are
 * merged so an existing scenario header is preserved; only `x-forwarded-for`
 * is deliberately replaced by the registered isolation identity.
 */
export function postBookingCreate(
  request: APIRequestContext,
  isolation: BookingCreateIsolation,
  options: BookingCreatePostOptions,
): Promise<APIResponse> {
  return request.post("/api/bookings", {
    ...options,
    headers: {
      ...options.headers,
      ...isolation.headers,
    },
  });
}

/**
 * Add the synthetic IP to exactly one browser-driven booking-create action.
 * Other page requests — including login, policy requests and availability —
 * retain their original headers. The completed action must issue exactly one
 * `POST /api/bookings`, so a stale census entry fails loudly.
 */
export async function withBookingCreateClientIp<T>(
  page: Page,
  isolation: BookingCreateIsolation,
  action: () => Promise<T>,
): Promise<T> {
  let matchingRequests = 0;
  const routePattern = "**/api/bookings";
  const isBookingCreate = (request: {
    method(): string;
    url(): string;
  }): boolean =>
    request.method() === "POST" &&
    new URL(request.url()).pathname === "/api/bookings";
  const handler: Parameters<Page["route"]>[1] = async (route) => {
    const request = route.request();
    if (!isBookingCreate(request)) {
      await route.continue();
      return;
    }

    matchingRequests += 1;
    await route.continue({
      headers: { ...request.headers(), ...isolation.headers },
    });
  };

  await page.route(routePattern, handler);
  const requestObserved = page.waitForRequest(isBookingCreate);
  let completed = false;
  try {
    const [result] = await Promise.all([action(), requestObserved]);
    completed = true;
    return result;
  } finally {
    await page.unroute(routePattern, handler);
    if (completed && matchingRequests !== 1) {
      throw new Error(
        `booking-create action ${isolation.key} issued ${matchingRequests} ` +
          "matching requests; expected exactly one",
      );
    }
  }
}
