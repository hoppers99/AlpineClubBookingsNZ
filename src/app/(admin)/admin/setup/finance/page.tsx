import { redirect } from "next/navigation";
import Link from "next/link";
import { Landmark, Plug, RefreshCw } from "lucide-react";
import { BackLink } from "@/components/admin/back-link";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { isFeatureHrefVisible } from "@/config/feature-routes";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  areLegacySetupSurfacesHidden,
  loadSetupSurfaceSettings,
} from "@/lib/setup-surface-settings";
import { loadAdminSetupPermissionMatrix } from "../permission-matrix";

const financeLinks = [
  {
    href: "/finance",
    title: "Finance Dashboard",
    description:
      "Open revenue, cost, sync health, finance reporting views, and the report-mapping editor.",
    icon: Landmark,
  },
  {
    href: "/admin/xero/setup",
    title: "Xero Setup",
    description:
      "Connect Xero and configure accounting settings used by finance workflows.",
    icon: Plug,
  },
  {
    href: "/admin/xero#xero-section-mappings",
    title: "Xero Mappings",
    description:
      "Review account, item-code, and entrance-fee mappings used by Xero sync.",
    icon: RefreshCw,
  },
];

export default async function FinanceSetupPage() {
  /*
    Epic #213 D8, C8 (#223): retired, so absent rather than deleted. The
    redirect, the reason a 404 would be the wrong answer, and why this is
    checked per page rather than in the proxy are all stated once, on
    `areLegacySetupSurfacesHidden`.

    THIS ONE REDIRECTS TO `/finance`, NOT `/admin/setup` (D-C8-1), and it is the
    only place the four hubs differ. Its report-mapping editor moved to the
    finance dashboard, so `/finance` is where the thing an operator came here
    for now is — and `/admin/setup` is a `support`-area page, so sending a
    finance-only officer there would answer a stale bookmark with a 403.

    …UNLESS THE FINANCE DASHBOARD MODULE IS OFF, in which case `/finance` is
    module-gated and the proxy answers it with a frozen 404. Redirecting a
    bookmark into a 404 is strictly worse than the 403 this decision exists to
    fix, and with the module off there is no dashboard and no report-mapping
    editor to send anybody to — so the answer falls back to the switch's own
    home. That is why the module flags are read BEFORE the redirect here and
    after it on the other three: those three's target does not depend on them.
  */
  const [features, permissionMatrix] = await Promise.all([
    loadEffectiveModuleFlags(),
    loadAdminSetupPermissionMatrix(),
  ]);
  if (areLegacySetupSurfacesHidden(await loadSetupSurfaceSettings())) {
    redirect(features.financeDashboard ? "/finance" : "/admin/setup");
  }
  const hasFinanceAccess = permissionMatrix.finance !== "none";
  const visibleLinks = hasFinanceAccess
    ? financeLinks.filter((link) => isFeatureHrefVisible(link.href, features))
    : [];

  return (
    <div className="space-y-8">
      <div>
        <div className="mb-2">
          <BackLink href="/admin/setup" label="Setup checklist" />
        </div>
        <h1 className="text-2xl font-bold text-foreground">Finance</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Open finance reporting, Xero setup, and sync mappings. The finance
          report mapping editor lives on the finance dashboard itself.
        </p>
      </div>

      {visibleLinks.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {visibleLinks.map(({ href, title, description, icon: Icon }) => (
            <Link key={href} href={href} className="group block">
              <Card className="h-full transition-colors hover:border-brand-gold/70">
                <CardHeader>
                  <div className="flex items-center gap-2">
                    <Icon className="h-5 w-5 shrink-0 text-foreground" />
                    <CardTitle>{title}</CardTitle>
                  </div>
                  <CardDescription>{description}</CardDescription>
                </CardHeader>
              </Card>
            </Link>
          ))}
        </div>
      ) : (
        <div className="rounded-md border bg-muted px-4 py-3 text-sm text-muted-foreground">
          Finance setup pages are not available for your current permissions
          and enabled modules.
        </div>
      )}
    </div>
  );
}
