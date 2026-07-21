import "server-only";

import { NextResponse } from "next/server";
import { isXeroMockActive } from "@/lib/xero-mock-endpoint";

/**
 * TEST-ONLY gate for the mock-Xero E2E endpoints (#2080).
 *
 * These routes simulate Xero's OWN servers (identity.xero.com / api.xero.com)
 * for the wizard happy-path E2E. They are PRODUCTION-INERT: unless
 * `XERO_MOCK_API_ORIGIN` is set (E2E staging only, never a real deployment),
 * every handler returns 404, so the endpoints do not exist in production.
 *
 * Returns a 404 response when the mock is inactive, else null (proceed).
 */
export function mockDisabledResponse(): NextResponse | null {
  if (isXeroMockActive()) return null;
  return new NextResponse("Not found", { status: 404 });
}
