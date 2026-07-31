import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";
import { z } from "zod";
import { BookingStatus, SubscriptionStatus } from "@prisma/client";
import { isAdditionalPaymentOwed } from "@/lib/additional-payment-chase";
import { getOccupiedBedsForNight } from "@/lib/capacity";
import { resolveMetricsCapacityAndScope } from "@/lib/finance-booking-metrics";
import { eachDayOfInterval, format } from "date-fns";
import logger from "@/lib/logger";
import { buildRevenueSeries } from "@/lib/admin-reports";
import { getSeasonYear } from "@/lib/utils";
import {
  OPERATIONAL_STAY_BOOKING_STATUSES,
  PAYMENT_OWED_BOOKING_STATUSES,
} from "@/lib/booking-status";
import {
  buildBookingDeletedWhere,
  parseBookingDeletedVisibility,
} from "@/lib/booking-delete-visibility";
import {
  endOfDateOnlyForTimeZone,
  parseDateOnly,
  startOfDateOnlyForTimeZone,
} from "@/lib/date-only";

const reportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  deleted: z.enum(["hide", "include", "only"]).default("hide"),
  // Reporting lodge scope: omitted = all active lodges (occupancy denominator
  // is the summed active-lodge capacity); a value scopes to that lodge.
  lodgeId: z.string().min(1).optional(),
});

export async function GET(request: NextRequest) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const { searchParams } = new URL(request.url);
  const parsed = reportQuerySchema.safeParse({
    from: searchParams.get("from"),
    to: searchParams.get("to"),
    deleted: parseBookingDeletedVisibility(searchParams.get("deleted")),
    lodgeId: searchParams.get("lodgeId") ?? undefined,
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid date range. Use ?from=YYYY-MM-DD&to=YYYY-MM-DD", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const fromDate = startOfDateOnlyForTimeZone(parsed.data.from);
  const toDate = endOfDateOnlyForTimeZone(parsed.data.to);
  const occupancyFromDate = parseDateOnly(parsed.data.from);
  const occupancyToDate = parseDateOnly(parsed.data.to);
  const deletedWhere = buildBookingDeletedWhere(parsed.data.deleted);

  if (toDate <= fromDate) {
    return NextResponse.json({ error: "to must be after from" }, { status: 400 });
  }

  // Validate an explicit lodge scope the way the write paths do (400 on
  // unknown/inactive). Omitted stays "all active lodges" — the sanctioned
  // reporting aggregate — so only validate when a lodgeId is supplied.
  if (
    parsed.data.lodgeId &&
    !(await resolveOptionalActiveLodgeId(prisma, parsed.data.lodgeId))
  ) {
    return NextResponse.json(
      { error: "Lodge not found or not active" },
      { status: 400 }
    );
  }

  try {
    const currentSeasonYear = getSeasonYear(new Date());
    const currentSeasonLabel = `${currentSeasonYear}/${currentSeasonYear + 1}`;

    const { capacity: lodgeCapacity, bookingLodgeWhere } =
      await resolveMetricsCapacityAndScope(parsed.data.lodgeId);

    const [
      bookings,
      occupancyBookings,
      totalActiveMembers,
      paidMembers,
      unpaidMembers,
      overdueMembers,
      newMembers,
    ] = await Promise.all([
      prisma.booking.findMany({
        where: {
          ...deletedWhere,
          createdAt: { gte: fromDate, lte: toDate },
        },
        include: {
          guests: true,
          payment: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      prisma.booking.findMany({
        where: {
          ...deletedWhere,
          ...bookingLodgeWhere,
          checkIn: { lte: toDate },
          checkOut: { gte: fromDate },
          status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
        },
        include: { guests: true },
      }),
      prisma.member.count({
        where: {
          active: true,
        },
      }),
      prisma.memberSubscription.count({
        where: {
          seasonYear: currentSeasonYear,
          status: SubscriptionStatus.PAID,
          member: { active: true },
        },
      }),
      prisma.memberSubscription.count({
        where: {
          seasonYear: currentSeasonYear,
          status: SubscriptionStatus.UNPAID,
          member: { active: true },
        },
      }),
      prisma.memberSubscription.count({
        where: {
          seasonYear: currentSeasonYear,
          status: SubscriptionStatus.OVERDUE,
          member: { active: true },
        },
      }),
      prisma.member.count({
        where: {
          active: true,
          OR: [
            { joinedDate: { gte: fromDate, lte: toDate } },
            {
              joinedDate: null,
              createdAt: { gte: fromDate, lte: toDate },
            },
          ],
        },
      }),
    ]);

    // 1. Occupancy by date
    const days = eachDayOfInterval({ start: occupancyFromDate, end: occupancyToDate });

    // Custodian occupancy (#2286) is deliberately EXCLUDED here. Utilisation
    // reporting measures how much the lodge was BOOKED, so a bed held for a
    // season by a custodian — which no member could have booked — must not
    // inflate the occupancy rate. The consequence is stated in
    // docs/CAPACITY_MODEL.md: during custodian season this report reads
    // slightly low against the lodge's true fullness. Every ADMISSION path and
    // the capacity-warnings cron count the custodian; only this report and the
    // other utilisation surfaces do not.
    const occupancyByDate = days.map((day) => {
      const beds = getOccupiedBedsForNight(day, occupancyBookings);
      return {
        date: format(day, "yyyy-MM-dd"),
        occupiedBeds: beds,
        availableBeds: lodgeCapacity - beds,
        occupancyRate:
          lodgeCapacity > 0 ? Math.round((beds / lodgeCapacity) * 100) : 0,
      };
    });

    // 2. Revenue by dynamic granularity
    const revenueSeries = buildRevenueSeries(bookings, occupancyFromDate, occupancyToDate);

    // 3. Booking trends by week
    const bookingsByWeek: Record<string, { total: number; confirmed: number; cancelled: number; bumped: number; pending: number }> = {};
    for (const b of bookings) {
      // ISO week start (Monday) - use a copy to avoid mutation
      const d = new Date(b.createdAt);
      const day = d.getDay();
      const diff = day === 0 ? -6 : 1 - day; // days to subtract to reach Monday
      const weekStart = new Date(d);
      weekStart.setDate(d.getDate() + diff);
      const weekKey = format(weekStart, "yyyy-MM-dd");

      if (!bookingsByWeek[weekKey]) {
        bookingsByWeek[weekKey] = { total: 0, confirmed: 0, cancelled: 0, bumped: 0, pending: 0 };
      }
      bookingsByWeek[weekKey].total += 1;
      if ((OPERATIONAL_STAY_BOOKING_STATUSES as readonly string[]).includes(b.status)) {
        bookingsByWeek[weekKey].confirmed += 1;
      } else if (b.status === BookingStatus.CANCELLED) {
        bookingsByWeek[weekKey].cancelled += 1;
      } else if (b.status === BookingStatus.BUMPED) {
        bookingsByWeek[weekKey].bumped += 1;
      } else if (
        b.status === BookingStatus.PENDING ||
        (PAYMENT_OWED_BOOKING_STATUSES as readonly string[]).includes(b.status)
      ) {
        bookingsByWeek[weekKey].pending += 1;
      }
    }

    const trendData = Object.entries(bookingsByWeek)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, data]) => ({
        week,
        ...data,
      }));

    // 4. Member vs non-member split
    let memberGuests = 0;
    let nonMemberGuests = 0;
    for (const b of bookings) {
      if (b.status === BookingStatus.CANCELLED || b.status === BookingStatus.BUMPED) continue;
      for (const g of b.guests) {
        if (g.isMember) memberGuests++;
        else nonMemberGuests++;
      }
    }

    // 5. Summary stats
    const activeBookings = bookings.filter(
      (b) => b.status !== BookingStatus.CANCELLED && b.status !== BookingStatus.BUMPED
    );
    // What the club BOOKED, not what it collected: the sum of every active
    // booking's final price, whether or not the money has arrived. #2350 named
    // the figure honestly rather than changing it, and added the shortfall
    // beside it.
    const totalRevenueCents = activeBookings.reduce((sum, b) => sum + b.finalPriceCents, 0);
    // #2350: upward changes whose extra was never collected. Counted separately
    // — it is already inside totalRevenueCents (finalPriceCents includes the
    // increase), so subtracting this from that is what "collected" looks like.
    //
    // Scoped by the SHARED owed predicate, which narrows this further than the
    // revenue figure beside it: `activeBookings` is everything except CANCELLED
    // and BUMPED, so it also holds DRAFT / PENDING / PAYMENT_PENDING /
    // WAITLISTED / AWAITING_REVIEW bookings whose delta is not a collectable
    // obligation. Using the predicate keeps this number equal to the one the
    // dashboard card, the sidebar badge, the bookings list and the chase cron
    // all report.
    const outstandingAdditional = activeBookings.reduce(
      (acc, b) => {
        if (!isAdditionalPaymentOwed({ bookingStatus: b.status, payment: b.payment }))
          return acc;
        return {
          bookings: acc.bookings + 1,
          cents: acc.cents + (b.payment?.additionalAmountCents ?? 0),
        };
      },
      { bookings: 0, cents: 0 }
    );
    const totalGuests = activeBookings.reduce((sum, b) => sum + b.guests.length, 0);
    const avgOccupancy =
      occupancyByDate.length > 0
        ? Math.round(
            occupancyByDate.reduce((sum, d) => sum + d.occupancyRate, 0) /
              occupancyByDate.length
          )
        : 0;

    // 6. Status breakdown
    const statusBreakdown = {
      confirmed: bookings.filter((b) => b.status === BookingStatus.PAYMENT_PENDING || b.status === BookingStatus.CONFIRMED).length,
      paid: bookings.filter((b) => b.status === BookingStatus.PAID).length,
      completed: bookings.filter((b) => b.status === BookingStatus.COMPLETED).length,
      pending: bookings.filter((b) => b.status === BookingStatus.PENDING).length,
      cancelled: bookings.filter((b) => b.status === BookingStatus.CANCELLED).length,
      bumped: bookings.filter((b) => b.status === BookingStatus.BUMPED).length,
    };

    return NextResponse.json({
      summary: {
        totalBookings: activeBookings.length,
        totalRevenueCents,
        // #2350: booked-versus-collected, so an admin reading the revenue figure
        // can see how much of it is still owing.
        outstandingAdditionalCents: outstandingAdditional.cents,
        outstandingAdditionalBookings: outstandingAdditional.bookings,
        totalGuests,
        avgOccupancyRate: avgOccupancy,
        memberGuests,
        nonMemberGuests,
      },
      statusBreakdown,
      memberStats: {
        totalActiveMembers,
        paidMembers,
        unpaidMembers,
        overdueMembers,
        newMembers,
        currentSeasonYear,
        currentSeasonLabel,
      },
      occupancy: occupancyByDate,
      revenueGranularity: revenueSeries.granularity,
      revenue: revenueSeries.data,
      trends: trendData,
    });
  } catch (err) {
    logger.error({ err }, "Error generating reports");
    return NextResponse.json({ error: "Failed to generate reports" }, { status: 500 });
  }
}
