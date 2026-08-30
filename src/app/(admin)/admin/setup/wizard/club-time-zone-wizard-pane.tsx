"use client";

import { useSession } from "next-auth/react";
import { ClubTimeZonePanel } from "@/components/admin/club-time-zone-panel";
import { isFullAdmin } from "@/lib/access-roles";

/**
 * The club time-zone editor, in the wizard (`club-time-zone`).
 *
 * **This one is not a bare embed, and must not become one.**
 * `ClubTimeZonePanel` is Full-Admin-only — `/api/admin/club-time-zone` guards
 * both verbs with `requireAdmin({ permission: false })` — and it deliberately
 * renders NO view-only banner, because it has no view tier and no edit tier for
 * one to describe (its own docblock explains this at length, and asks not to be
 * "fixed"). Its page shell therefore carries the gate: `/admin/club-time`
 * tests `isFullAdmin` and swaps in a short "full administrators only" panel.
 *
 * This replicates that shell test, including the `session &&` guard. While the
 * session is still resolving there are no access roles to read, and answering
 * "not a full admin" from an empty array would flash the refusal at the very
 * administrators who are allowed in. The panel is shown in that window; the
 * server is the real gate either way, and this check exists only so the screen
 * does not offer an action it already knows will be refused.
 *
 * No wrapping card: unlike `ClubIdentityPanel`, this panel renders its own
 * `rounded-md border bg-card`, and nesting a second one around it would put two
 * borders on one editor.
 */
export function ClubTimeZoneWizardPane() {
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

  return <ClubTimeZonePanel />;
}

