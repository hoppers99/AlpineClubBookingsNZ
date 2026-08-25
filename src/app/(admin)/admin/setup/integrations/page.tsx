import { redirect } from "next/navigation";
import { Activity, MailCheck, Plug, Puzzle, RefreshCw } from "lucide-react";
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
    href: "/admin/xero/setup",
    title: "Xero Setup",
    description:
      "Connect Xero and configure accounting settings used by provider-backed workflows.",
    icon: Plug,
  },
  {
    href: "/admin/xero",
    title: "Xero Sync",
    description:
      "Review operational Xero sync status, mappings, and recent provider activity.",
    icon: RefreshCw,
  },
  {
    href: "/admin/modules",
    title: "Modules",
    description:
      "Enable provider-backed modules only when the club is ready to operate them.",
    icon: Puzzle,
  },
  {
    href: "/admin/email-deliverability",
    title: "Email Deliverability",
    description:
      "Review SES/SMTP delivery state and suppression diagnostics.",
    icon: MailCheck,
  },
  {
    href: "/admin/health",
    title: "Provider Health",
    description:
      "Run safe runtime and provider readiness checks from the health page.",
    icon: Activity,
  },
];

export default async function OperationalIntegrationsSetupHubPage() {
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
      title="Operational Integrations"
      description="Check the provider-backed setup pages used by accounting, email, modules, and runtime readiness."
      sections={sections}
      features={features}
      permissionMatrix={permissionMatrix}
      backHref="/admin/setup"
      backLabel="Setup checklist"
    />
  );
}
