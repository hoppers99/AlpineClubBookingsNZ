import { NextResponse } from "next/server";

import { PolicyExceptionMemberMessageError } from "@/lib/booking-exception-requests";
import {
  LostSupersedeClaimError,
  NoEligiblePolicyExceptionError,
  OpenExceptionRequestConflictError,
} from "@/lib/booking-exception-request-service";

/**
 * Map a request-creation domain error to its HTTP response. Shared by every
 * policy-exception request route so new-booking and modification surfaces answer
 * the same failure the same way. A non-domain error is rethrown for the route's
 * own catch/500 handling.
 */
export function mapExceptionRequestError(error: unknown): NextResponse {
  if (error instanceof PolicyExceptionMemberMessageError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof NoEligiblePolicyExceptionError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof OpenExceptionRequestConflictError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof LostSupersedeClaimError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  throw error;
}
