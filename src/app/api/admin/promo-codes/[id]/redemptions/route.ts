import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import {
  endOfDateOnlyForTimeZone,
  formatDateOnly,
  isDateOnlyString,
  startOfDateOnlyForTimeZone,
} from "@/lib/date-only";
import type { Prisma } from "@prisma/client";
import { createAuditLog } from "@/lib/audit";
import { BENEFICIAL_PROMO_ALLOCATION_FILTER } from "@/lib/promo";

const dateOnlyString = z.string().refine(isDateOnlyString, {
  message: "Date must be YYYY-MM-DD",
});

// Hard upper bound on rows returned by a single `?export=1` request. Keeps a
// full-filtered export bounded (mirroring the member-import cap convention of a
// fixed row ceiling) so one request can never stream an unbounded result set.
const EXPORT_MAX_ROWS = 10_000;

// Redeemed-date range (`from`/`to` are inclusive club-timezone days), an
// optional lodge filter, and page/pageSize pagination mirroring the waitlist
// admin route. Filtering never changes the all-time totals — those always cover
// every redemption of the code.
const redemptionsQuerySchema = z.object({
  from: dateOnlyString.optional(),
  to: dateOnlyString.optional(),
  lodgeId: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

function memberName(member: { firstName: string; lastName: string }): string {
  return `${member.firstName} ${member.lastName}`.trim();
}

// Human-friendly booking reference derived from the cuid (bookings carry no
// separate reference column). Uppercased tail, matching the shortId convention
// used elsewhere in the admin surface; the link always uses the full id.
function bookingReference(id: string): string {
  return id.slice(-8).toUpperCase();
}

// checkIn/checkOut are `@db.Date` values (stored at UTC midnight), so the night
// count is a plain UTC day difference — never timezone-shift a lodge-night.
function nightCount(checkIn: Date, checkOut: Date): number {
  const ms = checkOut.getTime() - checkIn.getTime();
  return Math.max(0, Math.round(ms / 86_400_000));
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(req.url);
  const parsed = redemptionsQuerySchema.safeParse({
    from: searchParams.get("from") ?? undefined,
    to: searchParams.get("to") ?? undefined,
    lodgeId: searchParams.get("lodgeId") ?? undefined,
    page: searchParams.get("page") ?? undefined,
    pageSize: searchParams.get("pageSize") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid query", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { from, to, lodgeId, page, pageSize } = parsed.data;

  // Export mode returns the full filtered set (bounded by EXPORT_MAX_ROWS) in a
  // single request and — unlike normal paginated browsing — records a privacy
  // audit entry, mirroring the members-CSV export convention.
  const isExport = searchParams.get("export") === "1";

  if (from && to && to < from) {
    return NextResponse.json(
      { error: "to must be on or after from" },
      { status: 400 }
    );
  }

  // The redemptions report intentionally covers archived AND internal
  // (work-party) codes — unlike the promo CRUD routes, which hide internal
  // codes. Only a genuinely missing code is a 404.
  const promoCode = await prisma.promoCode.findUnique({ where: { id } });
  if (!promoCode) {
    return NextResponse.json({ error: "Promo code not found" }, { status: 404 });
  }

  if (lodgeId) {
    const lodge = await prisma.lodge.findUnique({
      where: { id: lodgeId },
      select: { id: true },
    });
    if (!lodge) {
      return NextResponse.json({ error: "Lodge not found" }, { status: 400 });
    }
  }

  // Redeemed-date range in club time: gte start-of-`from`, lte end-of-`to`.
  const createdAtFilter: Prisma.DateTimeFilter = {};
  if (from) createdAtFilter.gte = startOfDateOnlyForTimeZone(from);
  if (to) createdAtFilter.lte = endOfDateOnlyForTimeZone(to);

  const filteredWhere: Prisma.PromoRedemptionWhereInput = {
    promoCodeId: id,
    ...(from || to ? { createdAt: createdAtFilter } : {}),
    ...(lodgeId ? { booking: { lodgeId } } : {}),
  };
  const allWhere: Prisma.PromoRedemptionWhereInput = { promoCodeId: id };

  const [
    allAggregate,
    allUniqueMembers,
    beneficialUniqueMembers,
    filteredAggregate,
    filteredUniqueMembers,
    // Lightweight full-history scan (asc) to rank each redemption as the nth
    // use by its member — independent of the date/lodge filter so the "2nd+
    // use" badge stays truthful even inside a narrow window. Ties broken by id
    // for a deterministic order.
    orderedForCode,
    redemptions,
  ] = await Promise.all([
    prisma.promoRedemption.aggregate({
      where: allWhere,
      _count: { _all: true },
      _sum: { discountCents: true, freeNightsUsed: true },
    }),
    prisma.promoRedemption.groupBy({
      by: ["memberId"],
      where: allWhere,
    }),
    // Distinct members who actually BENEFITED from the code (#2299). The tiles
    // report every application, but the cap progress must be measured against
    // what the unique-members cap really counts, or a code that was applied
    // fruitlessly reads as over its cap while still being perfectly usable.
    prisma.promoRedemptionAllocation.groupBy({
      by: ["memberId"],
      where: { promoCodeId: id, ...BENEFICIAL_PROMO_ALLOCATION_FILTER },
    }),
    prisma.promoRedemption.aggregate({
      where: filteredWhere,
      _count: { _all: true },
      _sum: { discountCents: true, freeNightsUsed: true },
    }),
    prisma.promoRedemption.groupBy({
      by: ["memberId"],
      where: filteredWhere,
    }),
    prisma.promoRedemption.findMany({
      where: allWhere,
      select: { id: true, memberId: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    prisma.promoRedemption.findMany({
      where: filteredWhere,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: isExport ? 0 : (page - 1) * pageSize,
      take: isExport ? EXPORT_MAX_ROWS : pageSize,
      include: {
        member: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        booking: {
          select: {
            id: true,
            checkIn: true,
            checkOut: true,
            lodge: { select: { id: true, name: true } },
          },
        },
        allocations: {
          orderBy: [{ discountCents: "desc" }, { id: "asc" }],
          include: {
            member: {
              select: { id: true, firstName: true, lastName: true },
            },
          },
        },
      },
    }),
  ]);

  const useIndexById = new Map<string, number>();
  const perMemberCount = new Map<string, number>();
  for (const row of orderedForCode) {
    const next = (perMemberCount.get(row.memberId) ?? 0) + 1;
    perMemberCount.set(row.memberId, next);
    useIndexById.set(row.id, next);
  }

  const rows = redemptions.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    member: {
      id: r.member.id,
      name: memberName(r.member),
      email: r.member.email,
    },
    booking: {
      id: r.booking.id,
      reference: bookingReference(r.booking.id),
      lodgeId: r.booking.lodge.id,
      lodgeName: r.booking.lodge.name,
      checkIn: formatDateOnly(r.booking.checkIn),
      checkOut: formatDateOnly(r.booking.checkOut),
      nights: nightCount(r.booking.checkIn, r.booking.checkOut),
    },
    eligibleGuestCount: r.eligibleGuestCount,
    discountCents: r.discountCents,
    freeNightsUsed: r.freeNightsUsed ?? 0,
    memberUseIndex: useIndexById.get(r.id) ?? 1,
    // The per-member split is only meaningful on a multi-member booking; a
    // single-allocation redemption just mirrors the row, so it is omitted.
    allocations:
      r.allocations.length > 1
        ? r.allocations.map((a) => ({
            memberId: a.memberId,
            name: memberName(a.member),
            discountCents: a.discountCents,
            freeNightsUsed: a.freeNightsUsed,
          }))
        : [],
  }));

  // Privacy audit: only a full export is recorded (normal paginated browsing is
  // an unaudited read-GET). Store just the applied filters and row count — never
  // any redemption row contents.
  if (isExport) {
    await createAuditLog({
      action: "promoRedemptions.exported",
      memberId: guard.session.user.id,
      category: "privacy",
      severity: "info",
      outcome: "success",
      summary: "Exported promo code redemptions CSV",
      metadata: {
        promoCodeId: id,
        filters: {
          from: from ?? null,
          to: to ?? null,
          lodgeId: lodgeId ?? null,
        },
        rowCount: rows.length,
      },
    });
  }

  return NextResponse.json({
    code: {
      id: promoCode.id,
      code: promoCode.code,
      description: promoCode.description,
      type: promoCode.type,
      active: promoCode.active,
      archived: promoCode.archivedAt != null,
      internal: promoCode.internal,
      currentRedemptions: promoCode.currentRedemptions,
      // What the usage caps are actually measured against (#2299): only
      // applications that gave someone a benefit. Every tile below still counts
      // every application; these two are what the cap progress uses.
      capUsage: {
        redemptions: promoCode.currentRedemptions,
        uniqueMembers: beneficialUniqueMembers.length,
      },
      caps: {
        maxRedemptionsTotal: promoCode.maxRedemptionsTotal,
        maxUniqueMembersTotal: promoCode.maxUniqueMembersTotal,
        maxUsesPerMember: promoCode.maxUsesPerMember,
        lifetimeFreeNightsCap: promoCode.lifetimeFreeNightsCap,
      },
    },
    totals: {
      all: {
        redemptions: allAggregate._count._all,
        uniqueMembers: allUniqueMembers.length,
        discountCents: allAggregate._sum.discountCents ?? 0,
        freeNightsUsed: allAggregate._sum.freeNightsUsed ?? 0,
      },
      filtered: {
        redemptions: filteredAggregate._count._all,
        uniqueMembers: filteredUniqueMembers.length,
        discountCents: filteredAggregate._sum.discountCents ?? 0,
        freeNightsUsed: filteredAggregate._sum.freeNightsUsed ?? 0,
      },
    },
    pagination: {
      page,
      pageSize,
      total: filteredAggregate._count._all,
    },
    rows,
  });
}
