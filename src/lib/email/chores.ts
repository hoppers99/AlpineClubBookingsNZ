import {
  choreRosterTemplate,
  hutLeaderAssignmentTemplate,
} from "../email-templates";
import {
  CLUB_HUT_LEADER_LABEL,
  CLUB_NAME,
} from "@/config/club-identity";
import { EMAIL_DEFAULT_LODGE_NAME } from "@/lib/email-message-settings";
import { formatNZDate } from "../nzst-date";
import { sendEmail } from "./core";
import type { EmailBookingContext } from "@/lib/booking-email-suppression";

// #1285: the "Chore Roster" notification preference is honored by the caller
// (`admin-roster-service.ts` via `shouldSendChoreRoster`), before a chore
// token is created — mirroring how check-in reminders are gated in their cron
// caller. This sender stays a pure transport so it never double-gates.
export async function sendChoreRosterEmail(
  // Booking whose stay this roster covers (#2258). A roster is delivered per
  // guest of a booking, so the per-booking "No emails" switch withholds it;
  // `"none"` covers a roster generated outside any booking.
  bookingContext: EmailBookingContext,
  email: string,
  guestName: string,
  date: string,
  chores: Array<{ name: string; description: string | null }>,
  choreLink?: string,
  // Booking's lodge (multi-lodge phase 8): see sendBookingConfirmedEmail.
  lodgeId?: string | null,
) {
  const formattedDate = new Date(date + "T00:00:00").toLocaleDateString(
    "en-NZ",
    {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    },
  );

  await sendEmail({
    to: email,
    subject: `Your chore roster for ${formattedDate} - ${EMAIL_DEFAULT_LODGE_NAME}`,
    html: choreRosterTemplate(guestName, date, chores, choreLink),
    bookingContext,
    templateName: "chore-roster",
    templateData: {
      guestName,
      formattedDate,
      choreName: chores.map((chore) => chore.name).join(", "),
      choreDescription: chores
        .map((chore) => chore.description ?? "")
        .filter(Boolean)
        .join(", "),
      choreLink: choreLink ?? "",
    },
    lodgeId,
  });
}

export async function sendHutLeaderAssignmentEmail(params: {
  email: string;
  firstName: string;
  startDate: Date;
  endDate: Date;
  pin: string;
  assignmentId: string;
}) {
  await sendEmail({
    to: params.email,
    subject: `Your ${CLUB_NAME} ${CLUB_HUT_LEADER_LABEL.toLowerCase()} assignment`,
    html: hutLeaderAssignmentTemplate(params),
    // Not booking-scoped: a hut-leader assignment is a roster duty spanning a
    // date range, not a message about anyone's booking (#2258).
    bookingContext: "none",
    templateName: "hut-leader-assignment",
    templateData: {
      firstName: params.firstName,
      startDate: formatNZDate(params.startDate),
      endDate: formatNZDate(params.endDate),
      pin: params.pin,
    },
  });
}
