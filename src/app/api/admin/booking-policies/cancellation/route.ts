import { NextRequest, NextResponse } from "next/server"
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma"
import { z } from "zod"
import { logAudit } from "@/lib/audit"
import { normalizeCancellationRule } from "@/lib/cancellation-rules"

const policySchema = z
  .object({
    rules: z.array(
      z.object({
        daysBeforeStay: z.number().int().min(0),
        refundPercentage: z.number().int().min(0).max(100),
        creditRefundPercentage: z.number().int().min(0).max(100).optional(),
        fixedFeeCents: z.number().int().min(0).optional(),
        creditFixedFeeCents: z.number().int().min(0).optional(),
      })
    ),
    nonMemberHoldDays: z.number().int().min(1).max(365).optional(),
    // Per-lodge override partition (ADR-001 resolved question 3). Omitted =
    // the club-wide (null lodgeId) rules. A lodge's rows REPLACE the
    // club-wide set at runtime; an empty rules array for a lodge removes the
    // override so the lodge reverts to club-wide.
    lodgeId: z.string().min(1).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.lodgeId && data.rules.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rules"],
        message: "At least one rule is required",
      })
    }
    if (data.lodgeId && data.nonMemberHoldDays !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nonMemberHoldDays"],
        message: "Hold days are club-wide and cannot be set per lodge",
      })
    }
  })

export async function GET(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  // Exact partition, not null-tolerant: null rows are the club-wide rules
  // and a lodge's rows are its override set (replace, never merge).
  const lodgeId = req.nextUrl.searchParams.get("lodgeId")
  const policies = await prisma.cancellationPolicy.findMany({
    where: { lodgeId: lodgeId ?? null },
    orderBy: { daysBeforeStay: "desc" },
  })

  const defaults = await prisma.bookingDefaults.findUnique({
    where: { id: "default" },
  })

  return NextResponse.json({
    rules: policies.map(normalizeCancellationRule),
    nonMemberHoldDays: defaults?.nonMemberHoldDays ?? 7,
    lodgeId: lodgeId ?? null,
  })
}

export async function PUT(req: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const body = await req.json()
  const parsed = policySchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { rules, nonMemberHoldDays, lodgeId } = parsed.data

  if (lodgeId) {
    const lodge = await prisma.lodge.findUnique({
      where: { id: lodgeId },
      select: { id: true, active: true },
    })
    if (!lodge || !lodge.active) {
      return NextResponse.json(
        { error: "Lodge not found or not active" },
        { status: 400 }
      )
    }
  }

  // Validate: days must be unique
  const sortedRules = [...rules]
    .map(normalizeCancellationRule)
    .sort((a, b) => b.daysBeforeStay - a.daysBeforeStay)
  const dayValues = sortedRules.map((r) => r.daysBeforeStay)
  if (new Set(dayValues).size !== dayValues.length) {
    return NextResponse.json(
      { error: "Each rule must have a unique number of days" },
      { status: 400 }
    )
  }

  // Replace the partition's rules atomically and update defaults. Scoping
  // the delete to one partition means editing the club-wide rules never
  // touches a lodge's override set and vice versa. Serializable isolation
  // stands in for the club-wide partition's unique guarantee until the
  // phase-2 contract release adds the null-partition partial unique index
  // (PostgreSQL treats nulls as distinct under [lodgeId, daysBeforeStay]).
  const result = await prisma.$transaction(async (tx) => {
    await tx.cancellationPolicy.deleteMany({
      where: { lodgeId: lodgeId ?? null },
    })
    await tx.cancellationPolicy.createMany({
      data: sortedRules.map((rule) => ({
        daysBeforeStay: rule.daysBeforeStay,
        refundPercentage: rule.refundPercentage,
        creditRefundPercentage: rule.creditRefundPercentage,
        fixedFeeCents: rule.fixedFeeCents,
        creditFixedFeeCents: rule.creditFixedFeeCents,
        lodgeId: lodgeId ?? null,
      })),
    })

    if (nonMemberHoldDays !== undefined) {
      await tx.bookingDefaults.upsert({
        where: { id: "default" },
        update: { nonMemberHoldDays },
        create: { id: "default", nonMemberHoldDays },
      })
    }

    const policies = await tx.cancellationPolicy.findMany({
      where: { lodgeId: lodgeId ?? null },
      orderBy: { daysBeforeStay: "desc" },
    })

    const defaults = await tx.bookingDefaults.findUnique({
      where: { id: "default" },
    })

    return {
      rules: policies.map(normalizeCancellationRule),
      nonMemberHoldDays: defaults?.nonMemberHoldDays ?? 7,
    }
  }, { isolationLevel: "Serializable" })

  logAudit({
    action: "cancellation-policy.update",
    memberId: session.user.id,
    details: `Updated to ${sortedRules.length} rules, holdDays=${nonMemberHoldDays ?? "unchanged"}, lodge=${lodgeId ?? "club-wide"}`,
  })

  return NextResponse.json(result)
}
