import { NextResponse } from "next/server";
import {
  CustodianBedHoldError,
  CustodianOverCapacityConfirmationRequiredError,
} from "@/lib/custodian-assignment";

/**
 * Map a custodian bed-hold refusal to its HTTP answer (#2286).
 *
 * Shared by the hut-leaders POST and PUT handlers so both speak the same
 * language to the same form. Returns null when the error is not a custodian
 * refusal, so the caller falls through to its own handling.
 *
 * Its own module rather than a helper exported from a route file: a Next.js
 * route module may only export route handlers and a small set of config
 * symbols, so exporting a helper from `route.ts` is a build error.
 */
export function custodianBedHoldErrorResponse(err: unknown) {
  if (err instanceof CustodianOverCapacityConfirmationRequiredError) {
    return NextResponse.json(
      {
        error: err.message,
        code: err.code,
        nightDetails: err.nightDetails,
        // #2286 review M5: live bookings the per-night figures do not count, so
        // the admin confirming an over-capacity night knows the real total may
        // be higher.
        nonHoldingBookings: err.nonHoldingBookings,
      },
      { status: err.status },
    );
  }
  if (err instanceof CustodianBedHoldError) {
    return NextResponse.json(
      { error: err.message, code: err.code, nights: err.nights },
      { status: err.status },
    );
  }
  return null;
}
