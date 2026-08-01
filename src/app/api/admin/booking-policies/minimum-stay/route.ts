import { NextRequest, NextResponse } from "next/server"
import { revalidatePublicPageContent } from "@/lib/public-content-revalidation"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { logAudit } from "@/lib/audit"
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only"
import { lockMinimumStayPolicySet } from "@/lib/minimum-stay-policy-set"

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
})

const createSchema = z.object({
  name: z.string().min(1).max(200),
  startDate: dateOnlyString,
  endDate: dateOnlyString,
  triggerDays: z.array(z.number().int().min(0).max(6)).min(1, "At least one trigger day is required"),
  minimumNights: z.number().int().min(2, "Minimum nights must be at least 2"),
  capacityMode: z.enum(["HOLD", "NO_HOLD"]),
  active: z.boolean().optional(),
  // Per-lodge override partition (ADR-001 resolved question 3). Omitted =
  // club-wide (null lodgeId). Any rows for a lodge REPLACE the club-wide
  // set at runtime for that lodge.
  lodgeId: z.string().min(1).optional(),
})

function canonicalTriggerDays(days: number[]): number[] {
  return [...new Set(days)].sort((a, b) => a - b)
}

export async function GET(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;
  // Exact partition, not null-tolerant: null rows are the club-wide rules
  // and a lodge's rows are its override set (replace, never merge).
  const lodgeId = request.nextUrl.searchParams.get("lodgeId")
  const policies = await prisma.minimumStayPolicy.findMany({
    where: { lodgeId: lodgeId ?? null },
    orderBy: { startDate: "desc" },
  })

  return NextResponse.json(policies)
}

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  try {
    const body = await request.json()
    const data = createSchema.parse(body)

    const startDate = parseDateOnly(data.startDate)
    const endDate = parseDateOnly(data.endDate)

    if (endDate <= startDate) {
      return NextResponse.json(
        { error: "End date must be after start date" },
        { status: 400 }
      )
    }

    const policy = await prisma.$transaction(async (tx) => {
      const lodgeId = data.lodgeId ?? null
      await lockMinimumStayPolicySet(tx)
      if (lodgeId) {
        const lodge = await tx.lodge.findUnique({
          where: { id: lodgeId },
          select: { id: true, active: true },
        })
        if (!lodge || !lodge.active) throw new InactivePolicyLodgeError()
      }
      return tx.minimumStayPolicy.create({
        data: {
          name: data.name,
          startDate,
          endDate,
          triggerDays: canonicalTriggerDays(data.triggerDays),
          minimumNights: data.minimumNights,
          capacityMode: data.capacityMode,
          active: data.active ?? true,
          lodgeId,
          version: 1,
        },
      })
    })

    logAudit({
      action: "minimum-stay-policy.create",
      memberId: session.user.id,
      targetId: policy.id,
      details: JSON.stringify({ lodgeId: policy.lodgeId, after: policy }),
    })

    revalidatePublicPageContent()
    return NextResponse.json(policy, { status: 201 })
  } catch (error) {
    if (error instanceof InactivePolicyLodgeError) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 },
      )
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation failed", details: error.issues },
        { status: 400 }
      )
    }
    return NextResponse.json(
      { error: "Failed to create minimum stay policy" },
      { status: 500 }
    )
  }
}

class InactivePolicyLodgeError extends Error {}
