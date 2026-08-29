"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Globe, Loader2, ServerCog } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { formatNZInstantOrRaw } from "@/lib/nzst-date";
import type {
  SetupWizardEnvironmentDecidedBy,
  SetupWizardEnvironmentRole,
  SetupWizardEnvironmentSafety,
  SetupWizardView,
  SetupWizardWithheldEmail,
} from "@/lib/setup-wizard-view";

/**
 * The launch panel (epic #213, **D9**) — the last screen of the journey.
 *
 * D9, quoted: "Setup-done, site-visible and environment-role are three separate
 * facts. The final wizard screen is a launch panel unlocked by setup-done, with
 * two independent levers." So:
 *
 * - **Unlocked by the traversal**, never by this component. `traversal.allResolved`
 *   (#219's F9 export) is the whole gate, and the shell will not render this
 *   panel without it.
 * - **Lever 1 is real, and it sends no theme.** Making the public site visible
 *   is the theme's `completedAt`, and this panel is the ONLY wizard surface
 *   allowed to set it — D9 puts it here explicitly and takes it away from the
 *   styling step (C7). It goes through `POST /api/admin/site-style/complete-setup`,
 *   which owns the same cache invalidation, audit row and `content`-area check
 *   the site-style PUT does, and touches one column.
 *
 *   IT USED TO USE THAT PUT, and that was a LOST UPDATE (#220 review F3). The
 *   PUT body is `.strict()` and rewrites every theme column, so publishing meant
 *   reading the whole theme on mount and posting it back — and a panel left open
 *   while another administrator changed the club's colours wrote the copy it read
 *   minutes earlier over their work. Reading the theme here at all was the
 *   defect; the panel now holds no theme.
 *
 *   Whether the site is already visible arrives on the wizard's own payload
 *   (`isSiteVisible`), which the shell refetches on focus — so this display
 *   follows the club rather than freezing at mount time, which the panel's own
 *   fetch never did.
 * - **Lever 2 CONSUMES, and never mutates** (C9, #224). The environment role
 *   belongs to upstream's ENV-SAFETY work (#3034/#3035/#3036): declaring
 *   production is a `.env` action by that design, so there is nothing here to
 *   mutate and never will be. `EnvironmentRoleSection` below reads the SAME
 *   resolution the `environment-role` readiness step and `/admin/environment`
 *   read — `resolveEnvironmentRole()` and `readWithheldApplicationEmail()`,
 *   carried on the wizard's own payload (`SetupWizardEnvironmentSafety`) rather
 *   than fetched or re-derived here. It names the role, says which source
 *   decided it, states plainly what a non-production installation withholds,
 *   and — when nothing has declared the role — shows the UNKNOWN guiding banner
 *   naming what is paused and where to declare it. No control is offered: this
 *   is pinned by "keeps the environment-role lever consume-only and
 *   independent" and mutation-verified.
 * - **The two are independent.** A configured internal staging site is
 *   legitimately visible AND non-production forever, so neither lever gates the
 *   other and neither is presented as unfinished business.
 * - **Outstanding work is stated, not hidden** (mockup 6). A club that skipped
 *   steps can still open, and is told exactly what it skipped.
 * - **A broken SERVER refuses the publish, and says why** (D17, C15 #246).
 *   Three of the five environment facts describe a deployment a club must not
 *   open on top of — nothing has declared whether this is the live site or a
 *   copy, a required runtime variable is missing or malformed, or the auth
 *   secret is too weak to store a credential. `view.launchBlockedBy` names
 *   whichever of them is not green, the publish button is disabled while that
 *   list is non-empty, and the reason is stated beside the button rather than
 *   only on the Server-environment panel. The gate is on the BUTTON and
 *   pointedly not on this panel's own rendering: an operator refused a publish
 *   needs the screen that explains the refusal to still be there.
 */

/** The words `/admin/environment` uses, so the two screens agree (C9, #224). */
const ENVIRONMENT_ROLE_LABEL: Record<SetupWizardEnvironmentRole, string> = {
  PRODUCTION: "Production — the club's live site",
  NON_PRODUCTION: "Non-production — a copy",
  UNKNOWN: "Not configured",
};

const ENVIRONMENT_ROLE_BADGE: Record<
  SetupWizardEnvironmentRole,
  "warning" | "secondary" | "destructive"
> = {
  PRODUCTION: "warning",
  NON_PRODUCTION: "secondary",
  UNKNOWN: "destructive",
};

const ENVIRONMENT_DECIDED_BY_LABEL: Record<SetupWizardEnvironmentDecidedBy, string> = {
  "deployment-declaration": "Decided by this deployment's own configuration.",
  "database-safer-override":
    "Decided by the safer override, switched on at Admin › Environment.",
  unresolved: "Nothing has decided it.",
};

/**
 * Copied — not imported — from `DECLARE_IT_NOTE` (`environment-role.ts:301-305`)
 * and `ENVIRONMENT_ROLE_VERSUS_RUNTIME_ROLE_DETAIL`
 * (`setup-readiness.ts:1076-1077`), which both attach this same warning to
 * every repair instruction they give. This component may not runtime-import
 * either source: `environment-role` sits in the client-server boundary
 * census's `FORBIDDEN_MODULES`, and `setup-readiness` would widen the client
 * bundle for no reason a type-only reference needs. A drift pass should diff
 * this sentence against both source constants when either changes.
 */
const APP_RUNTIME_ROLE_WARNING =
  'APP_RUNTIME_ROLE is a different variable — on the staging stack it holds the literal word "staging" — and changing it does not declare the environment role.';

/**
 * The withheld-email line, distinguishing upstream's four outcome kinds rather
 * than collapsing "mail might not be arriving" to a binary (#224 AC):
 *
 * - **suppressed** — a confirmed copy withholding delivery on purpose.
 *   Terminal, and nothing is wrong: this is containment working.
 * - **blocked** — nothing has declared which installation this is, so
 *   delivery fails closed. A fault with a one-line fix (the UNKNOWN banner).
 * - **failed** — the live site ALSO declares a mail capture, so every message
 *   is refused outright. A fault, and it can ONLY be read while role is
 *   PRODUCTION — see below.
 * - **business-withheld** — a club's own per-booking "No emails" switch.
 *   Entirely unrelated to environment safety and deliberately not counted in
 *   the number below (`environment-safety-withheld.ts` names why); named in
 *   the caller's markup rather than here so an operator does not mistake one
 *   for the other.
 *
 * `suppressed` and `blocked` share one counted total on the payload (upstream's
 * own design — see `environment-safety-admin-state.ts`), disambiguated by the
 * ROLE beside it: a NON_PRODUCTION count is suppressed, an UNKNOWN count is
 * blocked.
 *
 * `captureInProduction` IS READ ONLY UNDER role === "PRODUCTION" (#224 fix
 * round, F1/F2). `setup-readiness.ts`'s `buildEnvironmentRoleCheck` only ever
 * inspects this counter inside its own PRODUCTION branch, and its NON_PRODUCTION
 * and UNKNOWN branches call a `describeWithheldEmail` that has never heard of
 * it. This matters because the counter is a PERMANENT historical total —
 * `SKIPPED_NON_PRODUCTION` rows never expire — and a staging copy restored from
 * a live production dump (the whole premise of this epic) inherits whatever
 * `captureInProduction` count the production instance had accrued before the
 * restore. Reading that counter under a CURRENT role of NON_PRODUCTION or
 * UNKNOWN would print "this installation says it is BOTH the live site and a
 * mail capture" about a confirmed, correctly-declared copy — which is false and
 * sends an operator hunting for a fault that is not theirs.
 *
 * The earlier version of this function read `captureInProduction` before role
 * at all, which is exactly that bug (#224 review F1/F2).
 *
 * A PRODUCTION installation with `captureInProduction === 0` gets no line here
 * at all — the caller renders nothing — matching `setup-readiness.ts`'s own
 * comment on its role-gated withheld line: "Not rendered for PRODUCTION, where
 * nothing is held back for this reason and the line would be noise." That holds
 * whatever the (irrelevant, historical) total `count` says, because
 * `SKIPPED_NON_PRODUCTION` rows from a former life as a copy persist forever and
 * are not this installation's business now that it is confirmed live.
 */
function describeWithheldEmail(
  role: SetupWizardEnvironmentRole,
  withheld: SetupWizardWithheldEmail,
): { headline: string; detail: string } | null {
  if (!withheld.available) {
    return {
      headline: "Could not be counted",
      detail:
        "That is not the same as none: one says nothing has been held back, the other says nobody knows. Apply any pending database migrations, then check again.",
    };
  }
  if (role === "PRODUCTION") {
    if (withheld.captureInProduction === 0) {
      return null;
    }
    const count = withheld.captureInProduction;
    return {
      headline: `${count} message${count === 1 ? "" : "s"} FAILED — this installation says it is BOTH the live site and a mail capture`,
      detail:
        "Those cannot both be true, so nothing was sent. Set USE_AWS_SES or USE_SMTP_RELAY and remove USE_LOCAL_CAPTURE (or set it to false), then see Admin › Environment for detail and any message that needs a manual re-send.",
    };
  }
  if (withheld.count === 0) {
    return {
      headline: "None held back",
      detail:
        "Nothing has been withheld here for environment-safety reasons, which is what an installation nobody is using looks like.",
    };
  }
  const recently = withheld.mostRecentAt
    ? ` Most recently ${formatNZInstantOrRaw(withheld.mostRecentAt)}.`
    : "";
  if (role === "NON_PRODUCTION") {
    return {
      headline: `${withheld.count} message${withheld.count === 1 ? "" : "s"} SUPPRESSED`,
      detail: `This installation is confirmed non-production, so nothing is sent to members — that is the containment working, not a fault.${recently}`,
    };
  }
  return {
    headline: `${withheld.count} message${withheld.count === 1 ? "" : "s"} BLOCKED`,
    detail: `Nothing has declared which installation this is, so delivery fails closed until it is.${recently}`,
  };
}

/**
 * D9's role lever, un-stubbed (C9, #224). Split out of the panel below because
 * it is the one section with real branching to unit-test, and a named export
 * keeps that testable without rendering the whole panel and its publish flow.
 */
function EnvironmentRoleSection({
  safety,
}: {
  safety: SetupWizardEnvironmentSafety;
}) {
  const withheld = describeWithheldEmail(safety.role, safety.withheldEmail);
  // `null` is PRODUCTION with nothing held back for this reason — the row
  // would be noise on a healthy live site, so it is not rendered at all (see
  // `describeWithheldEmail`'s docblock).
  return (
    <div
      className="space-y-3 rounded-md border p-4"
      data-testid="setup-wizard-environment-role"
    >
      <div className="flex flex-wrap items-center gap-2">
        <ServerCog className="h-5 w-5 text-foreground" />
        <h3 className="text-base font-semibold text-foreground">
          Confirm what this instance is for
        </h3>
        <Badge variant={ENVIRONMENT_ROLE_BADGE[safety.role]}>
          {ENVIRONMENT_ROLE_LABEL[safety.role]}
        </Badge>
      </div>

      <p className="text-sm text-muted-foreground">
        {ENVIRONMENT_DECIDED_BY_LABEL[safety.decidedBy]} Whether this
        installation is the club&apos;s real site or a test copy decides
        whether it may email the real membership, so it is declared in the
        deployment&apos;s environment (<code>.env</code>) rather than switched
        on from this screen — a copy of the live database must never be able
        to declare itself the live site.
      </p>

      {safety.role === "UNKNOWN" ? (
        <div
          className="space-y-1 rounded-md border border-danger-6 bg-danger-3 p-3 text-sm"
          data-testid="setup-wizard-environment-role-unknown"
        >
          <p className="font-medium text-danger-11">
            Nothing has declared what this installation is, so it is paused.
          </p>
          {/*
            Two different causes land here, and the old wording only fit one of
            them (#224 fix round, F3). `environment-role.ts`'s own precedence
            rule (branch 2 vs branch 4b) sends {role: "UNKNOWN", decidedBy:
            "unresolved"} for BOTH "nothing declared" and "declared, but the
            safer-override record could not be read" — an unreadable override
            fails closed to UNKNOWN even under a declared production. Telling
            the second operator to set a variable that is already set sends
            them looking in the wrong place, so this now names both repairs and
            leaves which one applies to the readiness step / Admin ›
            Environment, which can actually tell them apart.
          */}
          <p className="text-danger-11">
            Email to members and writes to the club&apos;s Xero organisation do
            not run until it is declared — guessing wrong would mean emailing
            real members from a test copy. Set{" "}
            <code>APP_ENVIRONMENT_ROLE</code> to <code>production</code> or{" "}
            <code>non-production</code> in this deployment&apos;s{" "}
            <code>.env</code>, then restart. {APP_RUNTIME_ROLE_WARNING}
          </p>
          <p className="text-danger-11">
            If it is already set, the safer override&apos;s own record may
            instead be unreadable — repair with{" "}
            <code>prisma migrate deploy</code> or restored database access. See
            the Production Or Non-Production step earlier in this wizard, or
            Admin &rsaquo; Environment, for which cause applies here.
          </p>
        </div>
      ) : null}

      {safety.role === "NON_PRODUCTION" ? (
        <p className="text-sm text-muted-foreground">
          This installation is treated as a copy: it sends no email to
          members, and every Xero contact it touches has its email address
          replaced with one that cannot be delivered — so Xero cannot reach a
          member from here either.
        </p>
      ) : null}

      {safety.role === "PRODUCTION" ? (
        <p className="text-sm text-muted-foreground">
          This is the club&apos;s live site: email goes to real members, and
          accounting goes to the club&apos;s real Xero organisation.
        </p>
      ) : null}

      {withheld ? (
        <div className="space-y-1 rounded-md border bg-muted p-3">
          <p className="text-sm font-medium text-foreground">
            Application email held back for environment safety
          </p>
          <p className="text-sm text-foreground">{withheld.headline}</p>
          <p className="text-xs text-muted-foreground">{withheld.detail}</p>
          <p className="text-xs text-muted-foreground">
            This is separate from a club turning email off for one booking
            (its own &quot;No emails&quot; switch) — that is a deliberate,
            per-booking choice and is never part of this count.
          </p>
        </div>
      ) : null}

      <Link
        href="/admin/environment"
        className="text-sm font-medium text-primary underline underline-offset-2"
      >
        Open Admin &rsaquo; Environment
      </Link>
    </div>
  );
}

export function SetupWizardLaunchPanel({
  view,
  isSiteVisible,
  environmentSafety,
  permissionMatrix,
  onPublishActivity,
}: {
  view: SetupWizardView;
  /** From the wizard payload, refreshed by the shell's focus refetch. */
  isSiteVisible: boolean;
  /**
   * D9's role lever (C9, #224) — the SAME resolution the `environment-role`
   * readiness step and `/admin/environment` read, carried on the wizard's own
   * payload. Required, not optional: every caller must decide what an
   * unresolved role reads as rather than this component silently guessing
   * UNKNOWN on a missing prop, which is exactly the guess `resolveEnvironmentRole()`
   * itself refuses to make.
   */
  environmentSafety: SetupWizardEnvironmentSafety;
  permissionMatrix: AdminPermissionMatrix;
  /**
   * Told the moment a publish starts, and left true afterwards.
   *
   * The shell unmounts this panel when the traversal stops saying `allResolved`,
   * and a refetch can legitimately say that while a publish is in flight — a
   * step going stale under an upgrade, say. Unmounting mid-request would discard
   * the result: the operator would see the panel vanish with no idea whether the
   * site went live. So the panel tells the shell to pin it, and stays pinned
   * once the request finishes — SUCCESS OR FAILURE — so the answer, or the
   * error explaining why there is none, is actually read before it disappears.
   */
  onPublishActivity: (active: boolean) => void;
}) {
  const [published, setPublished] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // See the comment at the two lists below for why this is partitioned rather
  // than rendered as one.
  const deferredOutstanding = view.outstanding.filter((item) => item.deferred);
  const unchosenOutstanding = view.outstanding.filter((item) => !item.deferred);

  const canEditSite = permissionMatrix.content === "edit";
  /*
    D17's PUBLISH GATE (#246). Straight off the view, never re-derived: the
    traversal owns which environment facts hold the site shut, and a second
    predicate here would be the drift `launchBlockedBy` exists to prevent.

    IT GATES THE BUTTON, NOT THIS PANEL. The panel still renders on
    `allResolved` alone, because an operator refused a publish needs to be able
    to read WHY — unmounting the screen that explains the refusal is the one
    outcome worse than the refusal itself. This is also why the gate is not
    folded into `allResolved` upstream (D9's three separate facts; see the
    field's docblock in `setup-wizard-traversal.ts`).

    The SERVER is not gated here and is not gated by this child. C15 gates the
    control; closing `POST /api/admin/site-style/complete-setup` against a
    publish it should refuse is C16's, in a sibling lane. So this is a client
    guard over a server that will still accept a hand-rolled request — an
    honest statement of what has and has not shipped, not a claim of
    enforcement.
  */
  const launchBlockedBy = view.launchBlockedBy;
  const environmentBlocksPublish = launchBlockedBy.length > 0;
  // The server's answer wins for as long as this panel holds one, because the
  // payload behind `isSiteVisible` is a read that may predate the publish.
  const visible = published || isSiteVisible;

  async function makeSiteVisible() {
    setSaving(true);
    setError("");
    onPublishActivity(true);
    try {
      const response = await fetch("/api/admin/site-style/complete-setup", {
        method: "POST",
        credentials: "same-origin",
      });
      const body = (await response.json().catch(() => null)) as {
        isComplete?: boolean;
        error?: string;
      } | null;
      if (!response.ok || body?.isComplete !== true) {
        throw new Error(body?.error ?? "Failed to make the public site visible");
      }
      setPublished(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to make the public site visible",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className="space-y-4 rounded-md border bg-card p-5"
      data-testid="setup-wizard-launch-panel"
    >
      <div>
        <h2 className="text-2xl font-semibold text-foreground">Ready to open</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Every step in the journey is either done or deliberately skipped. Two
          separate things are left, and neither one depends on the other.
        </p>
      </div>

      {/*
        PARTITIONED ON `deferred`, BECAUSE THE HEADING MAKES A CLAIM (#237 fix
        round). "By your own choice" is true of a skipped step and of nothing
        else, and the list is not always all skipped steps: `launchPinned` keeps
        this panel mounted through a refetch — it has to, or a publish in flight
        would unmount mid-request — so a step that goes stale, or one a
        newly-enabled module contributes, can arrive here having been chosen by
        nobody. Rendering it under that heading told the operator they had
        skipped something they never saw.

        When the panel is NOT pinned this partition is inert: `allResolved`
        gates the panel and no non-deferred step survives it. That is the
        ordinary case, and it renders exactly as it did.
      */}
      {deferredOutstanding.length > 0 ? (
        <div
          className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11"
          data-testid="setup-wizard-outstanding"
        >
          <p className="font-medium">Still outstanding, by your own choice:</p>
          <ul className="mt-1 space-y-1">
            {deferredOutstanding.map((item) => (
              <li key={item.id}>{item.title} — skipped for now</li>
            ))}
          </ul>
        </div>
      ) : null}

      {unchosenOutstanding.length > 0 ? (
        <div
          className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11"
          data-testid="setup-wizard-outstanding-unchosen"
        >
          <p className="font-medium">Outstanding, and not by your choice:</p>
          <p className="mt-1">
            These came up while this panel was open — a step went back to
            needing another look, or a module you switched on brought its own
            steps with it. Nothing here was skipped, so go back and settle them.
          </p>
          <ul className="mt-1 space-y-1">
            {unchosenOutstanding.map((item) => (
              <li key={item.id}>{item.title}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <AdminViewOnlySectionBanner canEdit={canEditSite}>
        Content edit access is required to make the public site visible.
      </AdminViewOnlySectionBanner>

      <div className="space-y-3 rounded-md border p-4">
        <div className="flex items-center gap-2">
          <Globe className="h-5 w-5 text-foreground" />
          <h3 className="text-base font-semibold text-foreground">
            Make the public site visible
          </h3>
          {visible ? (
            <Badge variant="success">Live</Badge>
          ) : (
            <Badge variant="secondary">Not yet visible</Badge>
          )}
        </div>
        {visible ? (
          <p className="text-sm text-muted-foreground">
            The public site is live. Visitors see the club&apos;s pages rather
            than the holding screen.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Visitors currently see the holding screen. Making the site visible
            publishes the club&apos;s public pages with the styling you have set.
          </p>
        )}
        {error ? <p className="text-sm text-danger-11">{error}</p> : null}

        {/*
          THE REASON, WHERE THE REFUSAL IS (D17, #246). An operator standing at
          a disabled publish button is asking one question, and it is answered
          here rather than only on the environment panel they would otherwise
          have to go looking for.
        */}
        {!visible && environmentBlocksPublish ? (
          <div
            className="space-y-1 rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11"
            data-testid="setup-wizard-launch-environment-blocked"
          >
            <p className="font-medium">
              The public site cannot be made visible yet — this server is not
              ready for it.
            </p>
            <ul className="mt-1 space-y-1">
              {launchBlockedBy.map((row) => (
                <li key={row.id}>
                  <span className="font-medium">{row.title}</span>
                  {row.remedy ? ` — ${row.remedy.who}` : null}
                </li>
              ))}
            </ul>
            <p>
              None of this is yours to change from here. See{" "}
              <strong>About this server</strong> in the list on the left for the
              line to send to whoever runs it.
            </p>
          </div>
        ) : null}

        {visible ? null : (
          <ViewOnlyActionButton
            type="button"
            size="sm"
            canEdit={canEditSite}
            describeReason={false}
            disabled={saving || environmentBlocksPublish}
            onClick={makeSiteVisible}
            data-testid="setup-wizard-make-site-visible"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            Make the public site visible
          </ViewOnlyActionButton>
        )}
      </div>

      <EnvironmentRoleSection safety={environmentSafety} />
    </section>
  );
}
