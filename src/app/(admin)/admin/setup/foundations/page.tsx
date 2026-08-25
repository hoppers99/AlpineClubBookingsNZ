import { redirect } from "next/navigation";
import { Activity, BadgeInfo, Building2, ListChecks, Puzzle } from "lucide-react";
import {
  AdminHubPage,
  type AdminHubSection,
} from "@/components/admin-hub-page";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  areLegacySetupSurfacesHidden,
  loadSetupSurfaceSettings,
} from "@/lib/setup-surface-settings";
import { loadAdminSetupPermissionMatrix } from "../permission-matrix";

const sections: AdminHubSection[] = [
  {
    href: "/admin/setup",
    title: "Setup Checklist",
    description:
      "Review readiness KPIs, blockers, provider tests, and setup progress.",
    icon: ListChecks,
  },
  {
    // Cross-link to the content-gated identity cards under Admin > Appearance
    // (E3 follow-up #1966): admins who followed the "Setup" wording find the
    // club name / short name / hut-leader label overrides here. The href gates
    // on the content area via canViewAdminHrefWithMatrix, matching the
    // /api/admin/club-identity content:view/edit guard.
    href: "/admin/appearance/identity",
    title: "Club Identity",
    description:
      "Override the club name, short name, hut-leader label, and your lodge's public details shown across the site and emails.",
    icon: BadgeInfo,
  },
  {
    href: "/admin/modules",
    title: "Modules",
    description:
      "Enable or disable optional club features before opening related workflows.",
    icon: Puzzle,
  },
  {
    href: "/admin/lodges",
    title: "Lodges",
    description:
      "Create and maintain lodge records used by multi-lodge configuration.",
    icon: Building2,
  },
  {
    href: "/admin/health",
    title: "System Health",
    description:
      "Check runtime, database, provider, and background-job readiness.",
    icon: Activity,
  },
];

export default async function FoundationsSetupHubPage() {
  /*
    Epic #213 D8, C8 (#223). HIDDEN MEANS ABSENT, NOT DELETED — this issue's
    "hide, don't remove" is explicit — so the route still exists and answers,
    and it answers by sending the operator to the surface that replaced it. A
    404 was the other candidate and is the wrong shape here: 404 is what a
    DISABLED MODULE's route returns (`getFeatureFlagBlockResponse` in
    `src/proxy.ts`), because that surface has no successor and the module state
    is something the answer must not leak. This surface has a successor — every
    destination on this hub is a step of the wizard — and its state is a club
    preference an admin can read on the page they land on.

    The redirect target is `/admin/setup`, which stays reachable in BOTH
    positions and carries the switch: an operator who followed a stale bookmark
    lands where they can see why, and where they can put it back.

    Checked here rather than in the proxy on purpose. A proxy gate would put a
    settings read on the hot path for every request that matches the prefix,
    including the wizard's own; this is one query on four rarely-visited pages.
  */
  if (areLegacySetupSurfacesHidden(await loadSetupSurfaceSettings())) {
    redirect("/admin/setup");
  }
  const [features, permissionMatrix] = await Promise.all([
    loadEffectiveModuleFlags(),
    loadAdminSetupPermissionMatrix(),
  ]);

  return (
    <AdminHubPage
      title="Initial Setup"
      description="Start with first-install readiness, module activation, lodge records, and system health."
      sections={sections}
      features={features}
      permissionMatrix={permissionMatrix}
      backHref="/admin/setup"
      backLabel="Setup checklist"
    />
  );
}
