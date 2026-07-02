import { prisma } from "./prisma";
import { CAPACITY_HOLDING_BOOKING_STATUSES } from "@/lib/booking-status";
import { getLodgeCapacity } from "@/lib/lodge-capacity";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  formatDateOnlyForTimeZone,
  normalizeDateOnlyForTimeZone,
  parseDateOnly,
} from "@/lib/date-only";
import {
  countActiveGuestsForNight,
  type GuestStayRange,
} from "@/lib/booking-guest-stay-ranges";

type PrismaClient = typeof prisma;
type TransactionClient = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export { getLodgeCapacity } from "@/lib/lodge-capacity";

export interface NightAvailability {
  date: Date;
  occupiedBeds: number;
  availableBeds: number;
}

// Overlap filter for one lodge's capacity-holding bookings. Bookings with a
// null lodgeId (written before the phase-2 backfill or by a draining old
// colour during the expand deploy) still hold capacity: they are counted
// against every lodge, which is exact while one lodge exists and conservative
// afterwards. The null branch goes dead once the phase-2 contract release
// enforces NOT NULL — before a second lodge can be created.
function lodgeScopeFilter(lodgeId: string) {
  return { OR: [{ lodgeId }, { lodgeId: null }] };
}

/**
 * Serialize capacity-mutating booking transactions for one lodge. Replaces
 * the historical club-wide pg_advisory_xact_lock(1): bookings at different
 * lodges no longer contend. hashtextextended gives a stable per-lodge bigint
 * key; a cross-lodge hash collision only causes unnecessary serialization,
 * never a correctness problem. The lock releases at transaction end.
 *
 * $executeRaw, not $queryRaw: pg_advisory_xact_lock returns void, which the
 * driver adapter cannot deserialize as a result row — $queryRaw here fails
 * at runtime on every booking transaction (found in browser verification;
 * every other advisory lock in the codebase already uses $executeRaw).
 */
export async function acquireLodgeCapacityLock(
  tx: Pick<TransactionClient, "$executeRaw">,
  lodgeId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lodgeId}, 0))`;
}

function getMonthStartDateOnly(year: number, month: number): Date {
  const date = parseDateOnly(
    `${year}-${String(month + 1).padStart(2, "0")}-01`
  );

  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid month for availability: ${year}-${month + 1}`);
  }

  return date;
}

function getNextMonthStartDateOnly(year: number, month: number): Date {
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextMonthYear = month === 11 ? year + 1 : year;
  return getMonthStartDateOnly(nextMonthYear, nextMonth);
}

export function getOccupiedBedsForNight(
  night: Date,
  bookings: Array<{
    checkIn?: Date | null;
    checkOut?: Date | null;
    guests?: GuestStayRange[] | null;
  }>
): number {
  const nightKey = formatDateOnly(night);
  let occupiedBeds = 0;

  for (const booking of bookings) {
    if (!booking.checkIn || !booking.checkOut) {
      continue;
    }

    const bookingCheckInKey = formatDateOnlyForTimeZone(booking.checkIn);
    const bookingCheckOutKey = formatDateOnlyForTimeZone(booking.checkOut);

    if (nightKey >= bookingCheckInKey && nightKey < bookingCheckOutKey) {
      occupiedBeds += countActiveGuestsForNight(booking.guests, night, {
        checkIn: booking.checkIn,
        checkOut: booking.checkOut,
      });
    }
  }

  return occupiedBeds;
}

/**
 * Get the number of occupied beds for each night in a date range at one lodge.
 * A booking occupies beds from checkIn to checkOut-1 (nights).
 * Only counts bookings that intentionally reserve capacity.
 */
export async function getAvailability(
  lodgeId: string,
  checkIn: Date,
  checkOut: Date
): Promise<NightAvailability[]> {
  const lodgeCapacity = await getLodgeCapacity(lodgeId, prisma);
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const exclusiveEnd = normalizeDateOnlyForTimeZone(checkOut);
  const nights = eachDateOnlyInRange(start, exclusiveEnd);

  const overlappingBookings = await prisma.booking.findMany({
    where: {
      checkIn: { lt: exclusiveEnd },
      checkOut: { gt: start },
      status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
      ...lodgeScopeFilter(lodgeId),
    },
    include: {
      // Load each guest's explicit night set (issue #713) so non-contiguous
      // stays are counted only on the nights they actually occupy. Guests
      // without night rows fall back to the stayStart/stayEnd envelope.
      guests: { include: { nights: true } },
    },
  });

  return nights.map((night) => {
    const occupiedBeds = getOccupiedBedsForNight(night, overlappingBookings);

    return {
      date: night,
      occupiedBeds,
      availableBeds: lodgeCapacity - occupiedBeds,
    };
  });
}

/**
 * Check if there's enough capacity at one lodge for a given number of guests
 * across all nights.
 */
export async function checkCapacity(
  lodgeId: string,
  checkIn: Date,
  checkOut: Date,
  guestCount: number,
  excludeBookingId?: string,
  tx?: TransactionClient
): Promise<{ available: boolean; minAvailable: number; nightDetails: NightAvailability[] }> {
  const db = tx ?? prisma;
  const lodgeCapacity = await getLodgeCapacity(lodgeId, db);
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const exclusiveEnd = normalizeDateOnlyForTimeZone(checkOut);
  const nights = eachDateOnlyInRange(start, exclusiveEnd);

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: exclusiveEnd },
      checkOut: { gt: start },
      status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      ...lodgeScopeFilter(lodgeId),
    },
    include: {
      // Load each guest's explicit night set (issue #713) so non-contiguous
      // stays are counted only on the nights they actually occupy. Guests
      // without night rows fall back to the stayStart/stayEnd envelope.
      guests: { include: { nights: true } },
    },
  });

  const nightDetails: NightAvailability[] = nights.map((night) => {
    const occupiedBeds = getOccupiedBedsForNight(night, overlappingBookings);

    return {
      date: night,
      occupiedBeds,
      availableBeds: lodgeCapacity - occupiedBeds,
    };
  });

  const minAvailable = Math.min(...nightDetails.map((n) => n.availableBeds));

  return {
    available: minAvailable >= guestCount,
    minAvailable,
    nightDetails,
  };
}

export async function checkCapacityForGuestRanges(
  lodgeId: string,
  checkIn: Date,
  checkOut: Date,
  guests: GuestStayRange[],
  excludeBookingId?: string,
  tx?: TransactionClient
): Promise<{ available: boolean; minAvailable: number; nightDetails: NightAvailability[] }> {
  const db = tx ?? prisma;
  const lodgeCapacity = await getLodgeCapacity(lodgeId, db);
  const start = normalizeDateOnlyForTimeZone(checkIn);
  const exclusiveEnd = normalizeDateOnlyForTimeZone(checkOut);
  const nights = eachDateOnlyInRange(start, exclusiveEnd);

  if (nights.length === 0) {
    return { available: true, minAvailable: Number.POSITIVE_INFINITY, nightDetails: [] };
  }

  const overlappingBookings = await db.booking.findMany({
    where: {
      checkIn: { lt: exclusiveEnd },
      checkOut: { gt: start },
      status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
      ...(excludeBookingId ? { id: { not: excludeBookingId } } : {}),
      ...lodgeScopeFilter(lodgeId),
    },
    include: {
      // Load each guest's explicit night set (issue #713) so non-contiguous
      // stays are counted only on the nights they actually occupy. Guests
      // without night rows fall back to the stayStart/stayEnd envelope.
      guests: { include: { nights: true } },
    },
  });

  const nightDetails: NightAvailability[] = nights.map((night) => {
    const occupiedBeds = getOccupiedBedsForNight(night, overlappingBookings);
    const proposedBeds = countActiveGuestsForNight(guests, night, {
      checkIn: start,
      checkOut: exclusiveEnd,
    });

    return {
      date: night,
      occupiedBeds: occupiedBeds + proposedBeds,
      availableBeds: lodgeCapacity - occupiedBeds - proposedBeds,
    };
  });

  const minAvailable = Math.min(...nightDetails.map((n) => n.availableBeds));

  return {
    available: minAvailable >= 0,
    minAvailable,
    nightDetails,
  };
}

/**
 * Get a monthly availability summary for calendar display at one lodge.
 */
export async function getMonthAvailability(
  lodgeId: string,
  year: number,
  month: number
): Promise<Map<string, number>> {
  const startDate = getMonthStartDateOnly(year, month);
  const endDate = getNextMonthStartDateOnly(year, month);

  const overlappingBookings = await prisma.booking.findMany({
    where: {
      checkIn: { lt: endDate },
      checkOut: { gt: startDate },
      status: { in: [...CAPACITY_HOLDING_BOOKING_STATUSES] },
      ...lodgeScopeFilter(lodgeId),
    },
    include: {
      // Load each guest's explicit night set (issue #713) so non-contiguous
      // stays are counted only on the nights they actually occupy. Guests
      // without night rows fall back to the stayStart/stayEnd envelope.
      guests: { include: { nights: true } },
    },
  });

  const availability = new Map<string, number>();
  const nights = eachDateOnlyInRange(startDate, endDate);

  for (const night of nights) {
    const occupiedBeds = getOccupiedBedsForNight(night, overlappingBookings);

    const key = formatDateOnly(night);
    availability.set(key, occupiedBeds);
  }

  return availability;
}
