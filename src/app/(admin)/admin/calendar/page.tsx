import { notFound, redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import {
  canEditCalendarEvents,
  canManageCalendarEvents,
  canViewCalendarEvents,
} from "@/lib/calendar-access";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { CalendarView } from "@/components/calendar/calendar-view";

export const metadata = {
  title: "Calendar",
};

export default async function AdminCalendarPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // LOAD-BEARING, not belt-and-braces (#2241): the proxy's page matcher carries
  // `missing: [next-router-prefetch]`, so a Next router prefetch of
  // /admin/calendar never reaches the feature-route gate. This guard is what
  // makes the module switch real for a prefetched render.
  //
  // The organisation exclusion is here for symmetry with the member page rather
  // than because an ORG account can reach this route today — the admin layout's
  // permission gate already refuses one, since ORG confers no admin area access.
  // It costs one call and means the rule holds wherever the calendar is served.
  const modules = await loadEffectiveModuleFlags();
  if (!modules.eventsCalendar || !canViewCalendarEvents(session.user)) {
    notFound();
  }

  // Create authority is broader than edit/delete: committee members may ADD
  // events, but only lodge administrators may edit or delete them. Passing the
  // narrower edit gate as `allowEditExisting` keeps committee members out of the
  // Save/Delete controls (which the server would 403 anyway) so the UI matches
  // the real permission model — see src/lib/calendar-access.ts.
  const canManage = await canManageCalendarEvents(session.user);
  const canEdit = canEditCalendarEvents(session.user);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Calendar</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Club events and committee meetings. Committee members can add events;
          lodge administrators can also edit and delete them. Everyone else sees
          a read-only view.
        </p>
      </div>
      <CalendarView canManage={canManage} allowEditExisting={canEdit} />
    </div>
  );
}
