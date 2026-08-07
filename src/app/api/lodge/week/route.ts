import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { OPERATIONAL_STAY_BOOKING_STATUSES } from "@/lib/booking-status";
import { getGuestOperationalDayPresence } from "@/lib/booking-guest-stay-ranges";
import {
  addDaysDateOnly,
  eachDateOnlyInRange,
  formatDateOnly,
  parseDateOnly,
} from "@/lib/date-only";
import { getKioskDateRange } from "@/lib/kiosk-access";
import { OPERATIONALLY_PRESENT_GUEST_WHERE } from "@/lib/member-guest-consent";
import {
  checkLodgeAuth,
  kioskLodgeAuthErrorResponse,
  resolveKioskLodgeId,
} from "@/lib/lodge-auth";
import { lodgeNullTolerantScope } from "@/lib/lodges";
import { prisma } from "@/lib/prisma";
import {
  computeRosterDayStatusForStayingBookings,
  getRosterStatusStayingBookings,
} from "@/lib/roster-status";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const WEEK_DAYS = 7;

type DateRange = { minDate: string; maxDate: string } | null;

function isDateAccessible(date: string, range: DateRange): boolean {
  if (!range) return true;
  return date >= range.minDate && date <= range.maxDate;
}

async function resolveWeekAuth(req: NextRequest, dates: string[]) {
  let forbidden: Awaited<ReturnType<typeof checkLodgeAuth>> | null = null;

  for (const date of dates) {
    const authResult = await checkLodgeAuth(date, {
      request: req,
      allowPreview: true,
    });

    if (!authResult.error) {
      return { authResult, authDate: date };
    }

    if (authResult.status === 403) {
      forbidden = authResult;
      continue;
    }

    return { authResult, authDate: date };
  }

  return {
    authResult:
      forbidden ?? {
        error: "Forbidden" as const,
        status: 403 as const,
        tier: "none" as const,
        session: null,
      },
    authDate: dates[0],
  };
}

/**
 * GET /api/lodge/week?start=YYYY-MM-DD
 *
 * Returns counts-only lodge kiosk summaries for seven dates. Inaccessible dates
 * deliberately contain no counts or booking fields, so a partial hut-leader or
 * staying-guest window cannot reveal adjacent lodge activity.
 */
export async function GET(req: NextRequest) {
  const startStr = req.nextUrl.searchParams.get("start");
  if (!startStr || !dateSchema.safeParse(startStr).success) {
    return NextResponse.json(
      { error: "Invalid or missing start parameter" },
      { status: 400 }
    );
  }

  const startDate = parseDateOnly(startStr);
  if (Number.isNaN(startDate.getTime())) {
    return NextResponse.json({ error: "Invalid date" }, { status: 400 });
  }

  const endDate = addDaysDateOnly(startDate, WEEK_DAYS);
  const weekDates = eachDateOnlyInRange(startDate, endDate);
  const dateKeys = weekDates.map(formatDateOnly);
  const { authResult, authDate } = await resolveWeekAuth(req, dateKeys);

  if (authResult.error) {
    return NextResponse.json(
      { error: authResult.error },
      { status: authResult.status! }
    );
  }

  const dateRange =
    "pinSession" in authResult && authResult.pinSession
      ? authResult.pinSession.dateRange
      : "member" in authResult && authResult.member
        ? await getKioskDateRange(authResult.member, parseDateOnly(authDate))
        : null;

  let lodgeId: string;
  try {
    lodgeId = await resolveKioskLodgeId(authResult, prisma);
  } catch (err) {
    const denied = kioskLodgeAuthErrorResponse(err);
    if (denied) return denied;
    throw err;
  }

  const endInclusive = addDaysDateOnly(endDate, -1);
  const bookings = await prisma.booking.findMany({
    where: {
      status: { in: [...OPERATIONAL_STAY_BOOKING_STATUSES] },
      checkIn: { lte: endInclusive },
      checkOut: { gte: startDate },
      ...lodgeNullTolerantScope(lodgeId),
      guests: {
        some: {
          stayStart: { lte: endInclusive },
          stayEnd: { gte: startDate },
          ...OPERATIONALLY_PRESENT_GUEST_WHERE,
        },
      },
    },
    select: {
      id: true,
      checkIn: true,
      checkOut: true,
      guests: {
        // Owner decision D-12 (#2307): the week strip's staying / arriving /
        // departing counts are operational — what the leader on shift should
        // expect through the door — so an unconsented member guest is not in
        // them. Filtering both the booking `some` and this select keeps a
        // booking whose only overlapping guest is pending out of the week
        // entirely instead of showing it as a zero-guest day.
        where: { ...OPERATIONALLY_PRESENT_GUEST_WHERE },
        select: {
          stayStart: true,
          stayEnd: true,
          ageTier: true,
          nights: {
            select: {
              stayDate: true,
            },
          },
        },
      },
    },
    orderBy: [{ checkIn: "asc" }, { createdAt: "asc" }],
  });

  const assignments = await prisma.choreAssignment.findMany({
    where: {
      date: { gte: startDate, lt: endDate },
      booking: lodgeNullTolerantScope(lodgeId),
      choreTemplate: lodgeNullTolerantScope(lodgeId),
    },
    select: {
      date: true,
      status: true,
      bookingId: true,
    },
  });

  const days = weekDates.map((date, index) => {
    const dateKey = dateKeys[index];

    if (!isDateAccessible(dateKey, dateRange)) {
      return { date: dateKey, accessible: false };
    }

    // ONE CANDIDATE SET PER DAY (#2631). The headline count, the arriving and
    // departing counts and the roster colour are all read off this one list, so
    // the payload that started this work — `guestCount: 4` beside
    // `rosterStatus: "no-guests"` on a changeover morning — is impossible by
    // construction rather than by two rules happening to agree.
    const stayingBookings = getRosterStatusStayingBookings(bookings, date);

    let guestCount = 0;
    let arrivingCount = 0;
    let departingCount = 0;
    for (const { booking, presentGuests } of stayingBookings) {
      guestCount += presentGuests.length;
      for (const guest of presentGuests) {
        // Arriving and departing are the two halves of the same presence, so
        // they can only ever be a subset of `guestCount`. "Departing" means
        // LEAVES TODAY.
        const presence = getGuestOperationalDayPresence(guest, date, booking);
        if (presence.isArriving) arrivingCount += 1;
        if (presence.isDeparting) departingCount += 1;
      }
    }

    return {
      date: dateKey,
      accessible: true,
      guestCount,
      arrivingCount,
      departingCount,
      rosterStatus: computeRosterDayStatusForStayingBookings(
        dateKey,
        stayingBookings,
        assignments
      ).status,
    };
  });

  return NextResponse.json({
    start: startStr,
    days,
  });
}
