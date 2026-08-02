import {
  ADMIN_NOTIFICATION_PREFERENCE_SELECT,
  type AdminNotificationPreferenceKey,
  resolveEffectiveAdminNotificationPreferences,
} from "../admin-notification-preferences";
import {
  ADMIN_CAPABLE_MEMBER_WHERE,
  MEMBER_ACCESS_ROLE_SELECT,
} from "@/lib/access-role-definitions";
import { hasAdminAreaAccess } from "@/lib/admin-permissions";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { type EmailTemplateData } from "@/lib/email-message-renderer";
import {
  shouldSendAdminSystemEmail,
} from "@/lib/notification-delivery-policies";
import {
  recordAdminAlertDeliveryEscalation,
  type AdminAlertRecipientDeliveryOutcome,
} from "@/lib/email-admin-alert-escalation";
import { sendEmail } from "./core";
import { type EmailAttachment } from "./internal";

/**
 * Candidate rows for any admin-audience email (#2548). The audience is decided
 * from the access-role permission matrix, so every candidate must arrive with
 * its assignment rows AND their joined definitions — a definition-backed custom
 * role has `role: null` and resolves to nothing without them, which is exactly
 * how those roles used to be dropped from every alert.
 *
 * `canLogin` is filtered in SQL (see ADMIN_CAPABLE_MEMBER_WHERE) and re-checked
 * in the matrix — a `canLogin: false` member resolves to the empty matrix — so
 * a deactivated or login-disabled account can never be mailed an operator
 * alert.
 */
const ADMIN_AUDIENCE_CANDIDATE_SELECT = {
  email: true,
  canLogin: true,
  accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
} as const;

// test seam
/**
 * Recipients for the system-level email-infrastructure alerts that are sent
 * directly rather than through a preference category — today the fail-closed
 * withhold alert in `email/core.ts`. Support & System editors own that surface
 * (`/admin/health`, `/admin/email-deliverability`), and a Full Admin holds
 * `support: edit`, so this is a superset of the Full Admins it used to resolve
 * from the legacy `role: "ADMIN"` scalar (#2548).
 */
export async function getAdminEmails(): Promise<string[]> {
  const admins = await prisma.member.findMany({
    where: ADMIN_CAPABLE_MEMBER_WHERE,
    select: ADMIN_AUDIENCE_CANDIDATE_SELECT,
  });
  return admins
    .filter((admin) =>
      hasAdminAreaAccess(admin, { area: "support", level: "edit" }),
    )
    .map((a) => a.email);
}

/**
 * Recipients of one alert category: everyone whose access-role matrix covers
 * the category's area and who has not switched that category off (#2548).
 * Categories outside a member's areas are masked off regardless of the stored
 * row, so widening the audience beyond Full Admins never leaks another area's
 * alerts to a scoped officer.
 */
async function getAdminAlertEmails(
  preferenceKey: AdminNotificationPreferenceKey,
): Promise<string[]> {
  const admins = await prisma.member.findMany({
    where: ADMIN_CAPABLE_MEMBER_WHERE,
    select: {
      ...ADMIN_AUDIENCE_CANDIDATE_SELECT,
      notificationPreference: {
        select: ADMIN_NOTIFICATION_PREFERENCE_SELECT,
      },
    },
  });

  return admins
    .filter(
      (admin) =>
        resolveEffectiveAdminNotificationPreferences(
          admin,
          admin.notificationPreference,
        )[preferenceKey],
    )
    .map((admin) => admin.email);
}

/** Send an email to all active admins who opted into the alert category. */
export async function sendToAdmins({
  subject,
  html,
  templateName,
  preferenceKey,
  templateData,
  attachments,
}: {
  subject: string;
  html: string;
  templateName: string;
  preferenceKey: AdminNotificationPreferenceKey;
  templateData?: EmailTemplateData;
  attachments?: EmailAttachment[];
}) {
  const delivery = await shouldSendAdminSystemEmail({ templateName });
  if (!delivery.send) {
    logger.info(
      { templateName, deliveryMode: delivery.mode, reason: delivery.reason },
      "Skipped admin email by delivery policy",
    );
    return;
  }

  const emails = await getAdminAlertEmails(preferenceKey);
  const outcomes = await Promise.all(
    emails.map(async (email): Promise<AdminAlertRecipientDeliveryOutcome> => {
      try {
        const outcome = await sendEmail({
          to: email,
          subject,
          html,
          // Admin-audience alerts are NEVER withheld by a booking flag (#2258).
          // Belt and braces: the gate also exempts them by registry audience, so
          // even a future caller that threaded a bookingId here could not
          // silence an operator alert.
          bookingContext: "none",
          templateName,
          templateData,
          attachments,
        });

        // Admin alert recipients are real admin addresses, never walk-in
        // placeholders (#1935); fold the not-sent outcomes into "suppressed".
        return { status: outcome.status === "sent" ? "sent" : "suppressed" };
      } catch (err) {
        logger.error(
          { err, to: email, templateName },
          "Failed to send admin alert",
        );
        return { status: "failed" };
      }
    }),
  );

  if (
    outcomes.length > 0 &&
    outcomes.every((outcome) => outcome.status !== "sent")
  ) {
    await recordAdminAlertDeliveryEscalation({
      templateName,
      preferenceKey,
      outcomes,
    }).catch((err) =>
      logger.error(
        { err, templateName },
        "Failed to record undeliverable admin alert escalation",
      ),
    );
  }
}

export async function shouldSendDirectAdminSystemEmail(templateName: string) {
  const delivery = await shouldSendAdminSystemEmail({ templateName });
  if (!delivery.send) {
    logger.info(
      { templateName, deliveryMode: delivery.mode, reason: delivery.reason },
      "Skipped direct admin email by delivery policy",
    );
    return false;
  }
  return true;
}
