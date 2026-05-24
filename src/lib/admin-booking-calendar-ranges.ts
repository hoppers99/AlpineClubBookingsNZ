interface CalendarBookingRangeInput {
  checkIn: string;
  checkOut: string;
}

function parseCalendarDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function getAdminCalendarBookingDayRange(
  booking: CalendarBookingRangeInput,
  year: number,
  month: number
): { start: number; end: number } | null {
  const checkIn = parseCalendarDate(booking.checkIn);
  const checkOut = parseCalendarDate(booking.checkOut);
  const monthStart = new Date(year, month, 1);
  const monthEndExclusive = new Date(year, month + 1, 1);

  if (checkOut <= monthStart || checkIn >= monthEndExclusive) {
    return null;
  }

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const start = Math.max(
    1,
    checkIn < monthStart ? 1 : checkIn.getDate()
  );
  const end = Math.min(
    daysInMonth,
    checkOut >= monthEndExclusive ? daysInMonth : checkOut.getDate() - 1
  );

  return end >= start ? { start, end } : null;
}
