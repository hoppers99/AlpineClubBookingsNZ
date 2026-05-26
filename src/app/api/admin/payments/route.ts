import { NextRequest, NextResponse } from "next/server";
import {
  adminPaymentsQuerySchema,
  listAdminPayments,
} from "@/lib/admin-payments-service";
import { requireAdmin } from "@/lib/session-guards";

/**
 * GET /api/admin/payments
 * List payments with filtering, sorting, pagination, and summary totals.
 */
export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(request.url);
  const parsed = adminPaymentsQuerySchema.safeParse({
    status: searchParams.get("status") ?? undefined,
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    lastUpdatedFrom: searchParams.get("lastUpdatedFrom") ?? undefined,
    lastUpdatedTo: searchParams.get("lastUpdatedTo") ?? undefined,
    checkInFrom: searchParams.get("checkInFrom") ?? undefined,
    checkInTo: searchParams.get("checkInTo") ?? undefined,
    search: searchParams.get("search") ?? undefined,
    amountExact: searchParams.get("amountExact") ?? undefined,
    amountMin: searchParams.get("amountMin") ?? undefined,
    amountMax: searchParams.get("amountMax") ?? undefined,
    sortBy: searchParams.get("sortBy") ?? undefined,
    sortDir: searchParams.get("sortDir") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query parameters", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const result = await listAdminPayments(parsed.data);
  return NextResponse.json(result.body, result.init);
}
