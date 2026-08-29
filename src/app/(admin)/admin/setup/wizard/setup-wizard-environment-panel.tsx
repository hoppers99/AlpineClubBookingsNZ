"use client";

import Link from "next/link";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  PlayCircle,
  ServerCog,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { ADMIN_PERMISSION_AREAS } from "@/lib/admin-permissions";
import type { SetupWizardEnvironmentRow } from "@/lib/setup-wizard-view";
import type { SetupWizardProviderTestResult } from "./setup-wizard-step-frame";

/**
 * The SERVER-ENVIRONMENT PANEL (epic #213, **D17**, child C15 #246).
 *
 * ## What this screen is for
 *
 * UAT round 2 watched an administrator meet three consecutive wizard screens —
 * "Production Or Non-Production", "Runtime Environment", "Auth Secret
 * Strength" — that they could not act on, and click through all three to reach
 * the next thing they could. Their own presence in the wizard proved the site
 * was running; what the screens actually reported was the state of a `.env`
 * file on a server they had no access to.
 *
 * D17 takes those facts off the rail and puts them here. **The change is not
 * that they are hidden — it is that they stop pretending to be work.** Every
 * one of them still renders, green or amber, with the same readiness check's
 * own words behind it. What they no longer do is sit in the journey, count
 * against the percentage, or wait for a confirmation from somebody who cannot
 * give one.
 *
 * ## Three rules this component holds to
 *
 * 1. **A green row still renders.** The panel is a statement of what this
 *    deployment IS, not a list of complaints — an operator who has just been
 *    handed a site needs to be able to read "this installation is declared
 *    Production" as a positive fact. A panel that appeared only when something
 *    was wrong would leave them unable to tell "all fine" from "not checked".
 * 2. **The remedy names who does it, first.** R2-3's finding: telling somebody
 *    what is broken without telling them it is not theirs to fix reads as an
 *    accusation. Every remedy leads with who, then the one line to send them,
 *    and only then — collapsed — why it matters.
 * 3. **Amber does not stop the journey; three ambers stop the PUBLISH.** The
 *    walking gate and the launch gate are different questions (D9's three
 *    separate facts), and this panel is the whole reason an operator can find
 *    out why publish is refused. That is exactly why the launch gate could not
 *    be folded into `allResolved`: doing so would unmount the launch panel and
 *    take away the screen that explains itself.
 *
 * ## Why the provider tests are here
 *
 * `email-ses` and `sentry` carry a `provider-test` action, and it reached
 * operators through their wizard step until D17 moved the step. Carrying it
 * onto the row is what makes this a relocation rather than a deletion (#223's
 * lesson, pinned by the ACTION guard in
 * `setup-surface-registry-parity.test.ts`). It also earns its place on merit:
 * after a deployer says "I have fixed the email settings", pressing Test Email
 * is how an operator finds out whether they actually did.
 */

const STATUS_BADGE: Record<
  SetupWizardEnvironmentRow["status"],
  { variant: "success" | "warning" | "destructive" | "secondary"; label: string }
> = {
  complete: { variant: "success", label: "Ready" },
  warning: { variant: "warning", label: "Needs attention" },
  blocked: { variant: "destructive", label: "Not configured" },
  not_started: { variant: "secondary", label: "Not checked" },
};

function areaLabel(area: SetupWizardEnvironmentRow["permissionArea"]): string {
  return (
    ADMIN_PERMISSION_AREAS.find((entry) => entry.key === area)?.label ?? area
  );
}

function EnvironmentRow({
  row,
  canEdit,
  providerTesting,
  providerResult,
  onProviderTest,
}: {
  row: SetupWizardEnvironmentRow;
  canEdit: boolean;
  providerTesting: boolean;
  providerResult: SetupWizardProviderTestResult | null;
  onProviderTest: (provider: string) => void;
}) {
  const badge = STATUS_BADGE[row.status];
  const green = row.status === "complete";

  return (
    <div
      className="space-y-3 rounded-md border p-4"
      data-testid={`setup-wizard-environment-row-${row.id}`}
      data-status={row.status}
      data-blocks-launch={row.blocksLaunch ? "true" : "false"}
    >
      <div className="flex flex-wrap items-center gap-2">
        {green ? (
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success-11" />
        ) : (
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning-11" />
        )}
        <h3 className="text-base font-semibold text-foreground">{row.title}</h3>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        {/*
          Stated on the row itself as well as at the launch panel. An operator
          reading this panel is asking "what is wrong here"; an operator at the
          launch panel is asking "why can I not publish". They are the same
          fact and both readers deserve it where they are standing.
        */}
        {row.blocksLaunch ? (
          <Badge variant="outline" data-testid="setup-wizard-environment-blocks-launch">
            Holds the site shut
          </Badge>
        ) : null}
      </div>

      <p className="text-sm text-foreground">{row.message}</p>

      {row.details.length > 0 ? (
        <ul className="space-y-1 text-sm text-muted-foreground">
          {row.details.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>
      ) : null}

      {row.remedy ? (
        <div
          className="space-y-2 rounded-md border border-warning-6 bg-warning-3 p-3"
          data-testid={`setup-wizard-environment-remedy-${row.id}`}
        >
          {/* WHO, first — see rule 2 in this file's docblock. */}
          <p className="text-sm font-medium text-warning-11">
            {row.remedy.who}
          </p>
          {/* …then the line to send them, set apart so it is obviously a thing
              to be copied rather than prose to be read. */}
          <p className="rounded border border-warning-6 bg-card px-3 py-2 text-sm text-foreground">
            {row.remedy.send}
          </p>
          {/* …then why, collapsed. */}
          <details className="text-sm">
            <summary className="cursor-pointer text-warning-11 underline underline-offset-2">
              Why this matters
            </summary>
            <p className="mt-2 text-muted-foreground">{row.remedy.why}</p>
          </details>
        </div>
      ) : null}

      {providerResult?.message ? (
        <div
          data-testid={`setup-wizard-environment-provider-result-${row.id}`}
          className={`rounded-md border px-3 py-2 text-sm ${
            providerResult.ok
              ? "border-success-6 bg-success-3 text-success-11"
              : "border-danger-6 bg-danger-3 text-danger-11"
          }`}
        >
          {providerResult.message}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        {row.action ? (
          <ViewOnlyActionButton
            type="button"
            variant="outline"
            size="sm"
            canEdit={canEdit}
            describeReason={false}
            data-testid={`setup-wizard-environment-provider-test-${row.id}`}
            disabled={providerTesting}
            onClick={() => onProviderTest(row.action?.provider ?? "")}
          >
            {providerTesting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PlayCircle className="h-4 w-4" />
            )}
            {row.action.label}
          </ViewOnlyActionButton>
        ) : null}
        {row.href ? (
          <Link
            href={row.href}
            className="text-sm font-medium text-primary underline underline-offset-2"
          >
            Open the page that reports this
          </Link>
        ) : null}
      </div>

      {row.href ? (
        <p className="text-xs text-muted-foreground">
          That page belongs to {areaLabel(row.permissionArea)}.
        </p>
      ) : null}
    </div>
  );
}

export function SetupWizardEnvironmentPanel({
  rows,
  canEdit,
  providerRunning,
  providerResults,
  onProviderTest,
}: {
  rows: readonly SetupWizardEnvironmentRow[];
  /**
   * Support edit, the same answer `canChangeSetupProgress` gives — a provider
   * test writes an audit row, so it is an edit even though it changes no
   * setting. Nothing else on this panel is a control.
   */
  canEdit: boolean;
  providerRunning: string | null;
  providerResults: Record<string, SetupWizardProviderTestResult | undefined>;
  onProviderTest: (provider: string) => void;
}) {
  const blocking = rows.filter((row) => row.blocksLaunch);

  return (
    <section
      className="space-y-4 rounded-md border bg-card p-5"
      data-testid="setup-wizard-environment-panel"
    >
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <ServerCog className="h-5 w-5 text-foreground" />
          <h2 className="text-2xl font-semibold text-foreground">
            Server environment
          </h2>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          These are facts about the server this site runs on, not steps for you
          to complete. Nothing here is changed from this screen — each one is
          set by whoever installed and runs the site, and the wizard reports
          them so you know where you stand and who to ask.
        </p>
      </div>

      {blocking.length > 0 ? (
        <div
          className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11"
          data-testid="setup-wizard-environment-blocking-summary"
        >
          <p className="font-medium">
            {blocking.length === 1
              ? "One of these must be fixed before the public site can be made visible:"
              : `${blocking.length} of these must be fixed before the public site can be made visible:`}
          </p>
          <ul className="mt-1 space-y-1">
            {blocking.map((row) => (
              <li key={row.id}>{row.title}</li>
            ))}
          </ul>
          {/* The distinction the whole design turns on, said once, plainly. */}
          <p className="mt-1">
            You can carry on setting the club up in the meantime — none of these
            stops you working through the rest of the wizard.
          </p>
        </div>
      ) : null}

      <AdminViewOnlySectionBanner canEdit={canEdit}>
        Support edit access is required to run a provider test. You can still
        read every fact on this page.
      </AdminViewOnlySectionBanner>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          There is nothing to report about this deployment.
        </p>
      ) : (
        rows.map((row) => (
          <EnvironmentRow
            key={row.id}
            row={row}
            canEdit={canEdit}
            providerTesting={
              row.action ? providerRunning === row.action.provider : false
            }
            providerResult={
              row.action ? (providerResults[row.action.provider] ?? null) : null
            }
            onProviderTest={onProviderTest}
          />
        ))
      )}
    </section>
  );
}
