import { expect, type APIRequestContext } from "@playwright/test";

/**
 * RETRY IDEMPOTENCY HELPERS (issue #2302).
 *
 * `playwright.config.ts` sets `retries: 2` in CI. A retry re-runs the test (and,
 * for a `mode: "serial"` group, the WHOLE group) against the database the failed
 * attempt left behind — the suite prepares its seed ONCE per run, never between
 * attempts. So any spec that permanently mutates seeded state on its way to an
 * assertion turns one transient failure into three deterministic ones, and the
 * reported error becomes the pollution rather than the real cause.
 *
 * Three of the flakes in #2302 were exactly this:
 *  - `waitlist.spec.ts:57` — attempt 0 created Wanda's booking on the seeded-full
 *    window, so retries got `BOOKING_MEMBER_NIGHT_CONFLICT` where the spec
 *    asserts `CAPACITY_EXCEEDED`.
 *  - `xero-setup-wizard.spec.ts:48` — attempt 0 advanced the persisted wizard
 *    cursor past step 1, so retries never saw the step-1 heading.
 *  - `stripe-payment.spec.ts:40` — attempt 0 booked the persona onto its stay
 *    window, so retries could not reach the review step at all.
 *
 * The rule these helpers exist to enforce: a spec that mutates state must make
 * its OWN setup idempotent, in a `beforeAll`/`beforeEach` that re-runs on every
 * attempt. Never a sleep, never a retry-count bump, never a loosened assertion.
 * See docs/E2E_PLAYWRIGHT.md → "Retry idempotency".
 */

// Booking statuses `POST /api/bookings/<id>/cancel` accepts AND
// `GET /api/admin/bookings` can filter on (its VALID_STATUSES set has no
// AWAITING_REVIEW, so a leftover in that state is not reachable here — no spec
// creates one).
const CANCELLABLE_STATUS_FILTER = [
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "WAITLISTED",
  "WAITLIST_OFFERED",
].join(",");

/**
 * Cancels every live booking a named member owns that checks in on `checkIn`,
 * and returns how many it cancelled (0 on a clean first attempt).
 *
 * CANCELLED is outside `MEMBER_NIGHT_CONFLICT_BOOKING_STATUSES`
 * (src/lib/booking-member-night-conflicts.ts) and outside the capacity-holding
 * set, so cancelling is enough to restore the pre-attempt invariant — the
 * booking need not be deleted (and, not being a DRAFT, could not be).
 *
 * Driven entirely through the admin API the product already exposes: no direct
 * database access is introduced into the Playwright process, and no test-only
 * endpoint is added.
 *
 * @param adminRequest an ADMIN-authenticated request context (full admin: the
 *   cancel route's `notifyMember` opt-out is booking-management-admin only).
 */
export async function cancelMemberBookingsOnDate(
  adminRequest: APIRequestContext,
  { memberName, checkIn }: { memberName: string; checkIn: string },
): Promise<number> {
  const calendarMonth = checkIn.slice(0, 7);
  const listed = await adminRequest.get(
    `/api/admin/bookings?calendarMonth=${calendarMonth}&status=${CANCELLABLE_STATUS_FILTER}`,
  );
  expect(
    listed.ok(),
    `GET /api/admin/bookings?calendarMonth=${calendarMonth} (${listed.status()})`,
  ).toBeTruthy();

  const body = (await listed.json()) as {
    bookings: Array<{
      id: string;
      memberName: string;
      checkIn: string;
      status: string;
      deletedAt: string | null;
    }>;
  };

  const leftovers = body.bookings.filter(
    (booking) =>
      booking.memberName === memberName &&
      booking.checkIn === checkIn &&
      !booking.deletedAt,
  );

  for (const booking of leftovers) {
    // Credit, not card: these bookings are never paid, so no provider call is
    // made either way, and `credit` needs no Stripe intent to exist.
    const cancelled = await adminRequest.post(
      `/api/bookings/${booking.id}/cancel`,
      { data: { refundMethod: "credit", notifyMember: false } },
    );
    expect(
      cancelled.ok(),
      `cancel leftover ${booking.status} booking ${booking.id} on ${checkIn} ` +
        `(${cancelled.status()}): ${await cancelled.text()}`,
    ).toBeTruthy();
  }

  return leftovers.length;
}

/**
 * Returns the Xero setup wizard to its pre-attempt state: disconnected, with the
 * persisted step cursor rewound to step one.
 *
 * Both endpoints are idempotent — `disconnectXero()` is a no-op when no tokens
 * are stored (src/lib/xero-oauth.ts), and the wizard-progress write is a plain
 * upsert — so this is safe to run on a clean first attempt.
 *
 * Credentials are deliberately NOT cleared: the wizard spec re-enters them
 * through the "Replace credentials" branch, which is itself worth exercising.
 */
export async function resetXeroSetupWizard(
  adminRequest: APIRequestContext,
): Promise<void> {
  const disconnected = await adminRequest.post("/api/admin/xero/disconnect");
  expect(
    disconnected.ok(),
    `POST /api/admin/xero/disconnect (${disconnected.status()})`,
  ).toBeTruthy();

  const rewound = await adminRequest.post(
    "/api/admin/integrations/wizard-progress",
    {
      data: {
        wizardId: "xero",
        currentStepId: "create-app",
        completedStepIds: [],
      },
    },
  );
  expect(
    rewound.ok(),
    `POST /api/admin/integrations/wizard-progress (${rewound.status()})`,
  ).toBeTruthy();
}
