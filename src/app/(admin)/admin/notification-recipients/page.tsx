import { BackLink } from "@/components/admin/back-link";
import { Card, CardContent } from "@/components/ui/card";
import { prisma } from "@/lib/prisma";
import {
  ADMIN_NOTIFICATION_PREFERENCE_SELECT,
  adminNotificationKeysForMember,
  isAdminNotificationRecipient,
  resolveEffectiveAdminNotificationPreferences,
} from "@/lib/admin-notification-preferences";
import {
  ADMIN_CAPABLE_MEMBER_WHERE,
  MEMBER_ACCESS_ROLE_SELECT,
} from "@/lib/access-role-definitions";
import { ACCESS_ROLE_LABELS, isAccessRole } from "@/lib/access-roles";
import { AdminNotificationSettings } from "../notifications/notifications-settings";

/**
 * Every admin-portal user, not just Full Admins (#2548, owner decision
 * 2 Aug 2026). Scoped officers and holders of definition-backed custom roles
 * used to be invisible here — the grid queried the legacy `role: "ADMIN"`
 * scalar, which every scoped and custom role collapses to `USER` under — so
 * they could not be subscribed to anything even by hand. Candidates are read
 * with their joined role definitions and filtered through the permission
 * matrix, which is also what decides the alert categories each of them can
 * hold.
 */
async function getAdminNotificationRecipients() {
  const members = await prisma.member.findMany({
    where: ADMIN_CAPABLE_MEMBER_WHERE,
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }, { email: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      canLogin: true,
      accessRoles: { select: MEMBER_ACCESS_ROLE_SELECT },
      notificationPreference: {
        select: ADMIN_NOTIFICATION_PREFERENCE_SELECT,
      },
    },
  });

  return members.filter(isAdminNotificationRecipient).map((member) => ({
    id: member.id,
    name: `${member.firstName} ${member.lastName}`.trim(),
    email: member.email,
    roleLabels: member.accessRoles
      .map(
        (assignment) =>
          assignment.roleDefinition?.label ??
          (isAccessRole(assignment.role)
            ? ACCESS_ROLE_LABELS[assignment.role]
            : null),
      )
      .filter((label): label is string => Boolean(label)),
    availableKeys: adminNotificationKeysForMember(member),
    preferences: resolveEffectiveAdminNotificationPreferences(
      member,
      member.notificationPreference,
    ),
  }));
}

export default async function NotificationRecipientsPage() {
  const admins = await getAdminNotificationRecipients();

  return (
    <div className="space-y-8">
      <div>
        <BackLink href="/admin/notifications" label="Notifications & Email" />
        <h1 className="mt-2 text-2xl font-bold text-foreground">Recipients</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose which system alerts each admin user receives. Every admin user
          is listed — Full Admins and scoped officers alike. An admin can only
          be sent the alerts for the areas their role can edit, so a Booking
          Officer starts with the booking alerts switched on and the finance and
          membership ones unavailable. Changes save automatically.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <AdminNotificationSettings initialAdmins={admins} />
        </CardContent>
      </Card>
    </div>
  );
}
