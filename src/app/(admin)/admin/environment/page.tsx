"use client";

import { useSession } from "next-auth/react";

import { EnvironmentSafetyPanel } from "@/components/admin/environment-safety-panel";
import { isFullAdmin } from "@/lib/access-roles";

/**
 * Environment Safety — the Full-Admin surface for "is this installation the
 * club's live site, or a copy?" (ENV-SAFETY 1, #3034; epic #2986).
 *
 * THE WHOLE SCREEN IS FULL ADMIN, which is why it is shaped like
 * `/admin/club-time` and `/admin/config-transfer` rather than like an ordinary
 * settings section. There is no view tier and no edit tier to distinguish, so
 * there is nothing for `AdminViewOnlySectionBanner` to explain; a support-area
 * admin who reaches the page (the route is registered under `support` so it
 * resolves to a concrete permission area instead of the `overview` catch-all) is
 * told plainly that this one is Full Admin only. The real enforcement is
 * server-side — `requireAdmin({ permission: false })` on both verbs of
 * `/api/admin/environment-safety` — and this check exists so the screen does not
 * offer an action it knows will be refused.
 *
 * THE BLURB SAYS WHAT IS TRUE TODAY, which is less than an operator will expect.
 * #3034 establishes and reports the role; the containment that acts on it is
 * #3035 (email delivery) and #3036 (Xero contact email). Saying otherwise here
 * would have somebody restore a copy of the live database, read this page, and
 * believe the copy could not email the club's members — which today it still can.
 * The second paragraph goes when those land; the change that makes the claim true
 * is the change that gets to make it.
 */
export default function EnvironmentSafetyPage() {
  const { data: session } = useSession();
  const fullAdmin = isFullAdmin({
    accessRoles: session?.user?.accessRoles ?? [],
  });

  if (session && !fullAdmin) {
    return (
      <div className="rounded-md border bg-card p-6 text-sm text-muted-foreground">
        The environment setting is available to full administrators only.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-2xl font-bold">Environment Safety</h1>
        <p className="text-sm text-muted-foreground">
          Whether this installation is the club&apos;s live site or a copy of it.
          It matters because a copy restored from the live database holds real
          members and their real email addresses, so anything that reaches the
          outside world has to know which one it is running on. This site never
          guesses: the deployment says so explicitly, and where nothing says, the
          answer is &ldquo;not configured&rdquo; rather than either one.
        </p>
        <p className="text-sm text-muted-foreground">
          Today this page RECORDS and REPORTS that answer. The parts that act on
          it — holding back email to members, and keeping a copy&apos;s invoices
          out of the club&apos;s real accounting — land with the rest of this
          work, so do not treat a copy as safe to run against real data yet.
        </p>
      </div>
      <EnvironmentSafetyPanel />
    </div>
  );
}
