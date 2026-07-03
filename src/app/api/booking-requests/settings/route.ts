import { NextRequest, NextResponse } from "next/server";
import {
  getBookingRequestSettings,
  getPublicBookingRequestLodges,
} from "@/lib/booking-request";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

/**
 * Public read of the booking request pricing visibility setting, used by the
 * non-member booking request form to decide between "Request to Book" (with
 * indicative pricing) and "Request for Price" (no pricing shown).
 *
 * Also lists the ACTIVE lodges a requester may choose between (id and name
 * only — this endpoint is public). Empty for a single-lodge club, so the
 * forms render no lodge copy (ADR-002 presentation rule).
 */
export async function GET(request: NextRequest) {
  const rateLimited = applyRateLimit(rateLimiters.bookingQuery, request);
  if (rateLimited) return rateLimited;

  const [settings, lodges] = await Promise.all([
    getBookingRequestSettings(),
    getPublicBookingRequestLodges(),
  ]);
  return NextResponse.json({ ...settings, lodges });
}
