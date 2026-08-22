"use client";

import { useSession } from "next-auth/react";

import { ClubTimeZonePanel } from "@/components/admin/club-time-zone-panel";
import { isFullAdmin } from "@/lib/access-roles";

/**
 * Club Time Zone — the Full-Admin maintenance surface for the club's time zone
 * (CT-1, #2989; epic #2988).
 *
 * THE WHOLE SCREEN IS FULL ADMIN, which is why it is shaped like
 * `/admin/config-transfer` rather than like an ordinary settings section. There
 * is no view tier and no edit tier to distinguish, so there is nothing for
 * `AdminViewOnlySectionBanner` to explain; a support-area admin who reaches the
 * page (the route is registered under `support` so it resolves to a concrete
 * permission area rather than the `overview` catch-all) is told plainly that this
 * one is Full Admin only. The real enforcement is server-side —
 * `requireAdmin({ permission: false })` on both verbs of
 * `/api/admin/club-time-zone` — and this check exists so the screen does not
 * offer an action it knows will be refused.
 */
export default function ClubTimePage() {
  const { data: session } = useSession();
  const fullAdmin = isFullAdmin({
    accessRoles: session?.user?.accessRoles ?? [],
  });

  if (session && !fullAdmin) {
    return (
      <div className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
        The club time zone is available to full administrators only.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Club Time Zone</h1>
        <p className="text-sm text-muted-foreground">
          The one time zone this club runs on. Everything the site shows as a time
          — booking confirmations, rosters, reminders, cut-offs — is worked out
          from it, and so is when club-local scheduled jobs fire. It is a
          property of the CLUB, not of the server or of whoever is looking: a
          member reading the site from another country sees club time, not their
          own.
        </p>
      </div>
      <ClubTimeZonePanel />
    </div>
  );
}
