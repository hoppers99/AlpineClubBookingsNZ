"use client";

import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { formatNZDateTime } from "@/lib/nzst-date";

/**
 * The environment-safety panel (ENV-SAFETY 1, #3034; epic #2986).
 *
 * WHY THIS SURFACE DOES NOT USE `ViewOnlyActionButton` /
 * `AdminViewOnlySectionBanner`, and please do not "fix" it to. Those are the
 * canonical furniture for a section with a VIEW tier and an EDIT tier: they
 * resolve `useAdminAreaEditAccess(area)` and explain that this admin can look but
 * not change, because their access role grants the area at `view`. This screen
 * has exactly one permission level — Full Admin, enforced in the route by
 * `requireAdmin({ permission: false })` — so there is no area-edit tier to
 * describe, and rendering that banner here would state a REASON that is not the
 * reason. `/admin/environment`'s page shell therefore does what
 * `/admin/club-time` and `/admin/config-transfer` do: it tests `isFullAdmin` and
 * shows a short "available to full administrators only" panel instead of this
 * one. `docs/ARCHITECTURE.md` -> "Admin/member layer" names this as the
 * acknowledged shape for a whole-screen-Full-Admin surface.
 *
 * IT STILL FOLLOWS THE STAGED-EDIT MODEL. The panel mounts READ-ONLY showing
 * what this installation is and which source decided it; changing the override is
 * Switch -> acknowledge -> Save. Nothing persists on a click, and the
 * acknowledgement is not decoration — the API refuses an unconfirmed change, so a
 * caller that skips this panel gets the same refusal.
 *
 * THE BROWSER NEVER DECIDES THE ROLE. Everything shown here arrives from
 * `GET /api/admin/environment-safety`. There is no `process.env` read in this
 * file and there cannot be a useful one: `APP_ENVIRONMENT_ROLE` is deliberately
 * not a `NEXT_PUBLIC_` variable, so a browser would read `undefined` and report
 * "nothing has declared this installation" while the server read `production`.
 * That is the split-brain second authority INV-CONFIG-003 exists to prevent, and
 * `environment-role-declaration.ts` is a named forbidden leaf in the
 * client/server boundary census for exactly this reason.
 *
 * WHAT THIS SCREEN MAY CLAIM, which is narrower than it reads. #3034 RECORDS and
 * REPORTS the role; the containment that acts on it lands in #3035 (delivery) and
 * #3036 (Xero). So the copy below says what the role IS and what is coming, and
 * does not tell an operator that switching the override stops email today —
 * because today it does not. If you are the change that makes it true, this copy
 * is part of your diff.
 */

type EnvironmentRole = "PRODUCTION" | "NON_PRODUCTION" | "UNKNOWN";

type DecidedBy =
  | "deployment-declaration"
  | "database-safer-override"
  | "unresolved";

type DeclarationKind = "production" | "non-production" | "absent" | "invalid";

/**
 * How much application email this installation has held back for
 * environment-safety reasons.
 *
 * Declared here rather than imported, like every other type in this file: the
 * module that builds the payload is `server-only`, so a client component cannot
 * import from it. `available: false` is deliberately its own case and NOT a zero
 * — see `src/lib/environment-safety-withheld.ts` for why "none held back" and
 * "not counted yet" must not render the same, and why no heuristic over the
 * database's contents can do this job.
 */
type WithheldApplicationEmail =
  | { available: false }
  | { available: true; count: number; mostRecentAt: string | null };

type EnvironmentSafetyState = {
  role: EnvironmentRole;
  decidedBy: DecidedBy;
  declaration: { kind: DeclarationKind; raw: string | null };
  override: {
    on: boolean;
    readable: boolean;
    updatedAt: string | null;
    updatedByName: string | null;
  };
  withheldEmail: WithheldApplicationEmail;
  notes: string[];
};

/** The words the operator guide uses, so the screen and the guide agree. */
const ROLE_LABEL: Record<EnvironmentRole, string> = {
  PRODUCTION: "Production — the club's live site",
  NON_PRODUCTION: "Non-production — a copy",
  UNKNOWN: "Not configured",
};

const ROLE_TONE: Record<EnvironmentRole, string> = {
  PRODUCTION: "border-warning-6 bg-warning-2",
  NON_PRODUCTION: "border-border bg-muted",
  UNKNOWN: "border-danger-6 bg-danger-3",
};

const DECIDED_BY_LABEL: Record<DecidedBy, string> = {
  "deployment-declaration": "Decided by this deployment's configuration",
  "database-safer-override": "Decided by the safer override below",
  unresolved: "Nothing has decided it",
};

function describeDeclaration(state: EnvironmentSafetyState): string {
  switch (state.declaration.kind) {
    case "production":
      return "This deployment says production.";
    case "non-production":
      return "This deployment says non-production.";
    case "invalid":
      return `This deployment sets APP_ENVIRONMENT_ROLE to "${state.declaration.raw ?? ""}", which is not one of the two accepted values (production, non-production), so it is refused rather than guessed at.`;
    case "absent":
      return "This deployment does not set APP_ENVIRONMENT_ROLE at all.";
  }
}

/**
 * The withheld-email sentence.
 *
 * THIS IS THE SIGNAL THAT SEPARATES the two cases nothing else can tell apart: a
 * live club installation that has been wrongly declared a copy, and a copy nobody
 * is using. A copy restored from the live database holds the club's real members
 * and their real addresses, so no inspection of the DATA can distinguish them —
 * what distinguishes them is consequence. A real club wrongly declared a copy
 * holds back a steady stream of member mail; an idle copy holds back almost
 * nothing.
 *
 * The three states must read differently. "None" and "not counted yet" look
 * identical on a screen and mean opposite things: one says the copy is idle, the
 * other says nobody knows. **#3035 supplies the numbers** — see
 * `src/lib/environment-safety-withheld.ts`.
 */
function describeWithheldEmail(state: EnvironmentSafetyState): {
  headline: string;
  detail: string;
} {
  const withheld = state.withheldEmail;
  if (!withheld.available) {
    return {
      headline: "Not counted yet on this installation",
      detail:
        "This is not the same as none. Nothing here records what environment safety holds back yet, so this line cannot tell you whether this installation is quietly holding back mail the club's members are waiting for. Until it can, check the role above is the answer you expect.",
    };
  }
  if (withheld.count === 0) {
    return {
      headline: "None held back",
      detail:
        "Nothing has been held back on this installation for environment-safety reasons, which is what an unused copy looks like.",
    };
  }
  return {
    headline: `${withheld.count} message${withheld.count === 1 ? "" : "s"} held back`,
    detail: withheld.mostRecentAt
      ? `Most recently ${formatChangedAt(withheld.mostRecentAt)}. A steady and recent count is what a LIVE club that has been wrongly declared a copy looks like. If members are waiting for that mail, the role above is wrong.`
      : "A steady and recent count is what a LIVE club that has been wrongly declared a copy looks like. If members are waiting for that mail, the role above is wrong.",
  };
}

function describeOverride(state: EnvironmentSafetyState): string {
  if (!state.override.readable) {
    return "Could not be read from the database — the migration has probably not been applied here yet.";
  }
  return state.override.on
    ? "On — this installation is forced to be treated as a copy, whatever the deployment says."
    : "Off — the deployment's own setting decides.";
}

/**
 * "Last changed", in the same zone as every other admin timestamp.
 *
 * Deliberately NOT the club's configured zone. `/admin/audit-log` renders the
 * very same class of timestamp — the audit row this save writes — through
 * `APP_TIME_ZONE`, and one screen quietly spelling an instant in a different zone
 * from the screen beside it is worse than both sitting on the transitional
 * constant. `formatNZDateTime` pins locale and zone together, which is what
 * INV-DATE-015 and the ESLint date guard require of any formatter here.
 */
function formatChangedAt(iso: string): string {
  const changedAt = new Date(iso);
  return Number.isNaN(changedAt.getTime()) ? iso : formatNZDateTime(changedAt);
}

export function EnvironmentSafetyPanel() {
  const [state, setState] = useState<EnvironmentSafetyState | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acknowledgeId = useId();

  function load() {
    setLoadFailed(false);
    void fetch("/api/admin/environment-safety")
      .then(async (response) => {
        if (!response.ok) throw new Error("load failed");
        const payload = (await response.json()) as {
          state: EnvironmentSafetyState;
        };
        setState(payload.state);
      })
      .catch(() => setLoadFailed(true));
  }

  useEffect(() => {
    load();
  }, []);

  if (loadFailed) {
    return (
      <div className="space-y-3 rounded-md border bg-card p-6">
        <p className="text-sm text-danger">
          Could not load this installation&apos;s environment setting.
        </p>
        <Button variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  if (!state) {
    return (
      <p className="text-sm text-muted-foreground">
        Loading environment setting…
      </p>
    );
  }

  const target = !state.override.on;

  function startEditing() {
    setAcknowledged(false);
    setError(null);
    setEditing(true);
  }

  function cancelEditing() {
    setEditing(false);
    setAcknowledged(false);
    setError(null);
  }

  async function save() {
    if (!acknowledged) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/environment-safety", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ forceNonProduction: target, confirmed: true }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { state?: EnvironmentSafetyState; error?: string }
        | null;
      if (!response.ok || !payload?.state) {
        setError(payload?.error ?? "Could not save the change.");
        return;
      }
      setState(payload.state);
      cancelEditing();
    } catch {
      setError("Could not save the change.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div
        className={`space-y-1 rounded-md border p-6 ${ROLE_TONE[state.role]}`}
      >
        <p className="text-sm text-muted-foreground">This installation is</p>
        <p className="text-lg font-semibold" data-testid="environment-role">
          {ROLE_LABEL[state.role]}
        </p>
        <p className="text-sm">{DECIDED_BY_LABEL[state.decidedBy]}</p>
      </div>

      {/*
        Directly under the role, and only when this installation is treated as a
        copy. That is the one state in which application email is held back, so it
        is the one state in which the count answers a question — "is this costing
        my members their mail?". On a production or unconfigured installation the
        same line would be noise, and noise beside the most consequential setting
        in the app is how the consequential part stops being read.
      */}
      {state.role === "NON_PRODUCTION" ? (
        <div
          className="space-y-1 rounded-md border bg-card p-6"
          data-testid="environment-withheld-email"
        >
          <p className="text-sm font-semibold">
            Application email held back while this is a copy
          </p>
          <p className="text-base">{describeWithheldEmail(state).headline}</p>
          <p className="text-sm text-muted-foreground">
            {describeWithheldEmail(state).detail}
          </p>
        </div>
      ) : null}

      <div className="space-y-4 rounded-md border bg-card p-6">
        <div className="space-y-1">
          <p className="text-sm font-semibold">
            What this deployment&apos;s configuration says
          </p>
          <p className="text-sm text-muted-foreground">
            {describeDeclaration(state)}
          </p>
          <p className="text-xs text-muted-foreground">
            It is set outside the app, in this deployment&apos;s environment
            (APP_ENVIRONMENT_ROLE), and cannot be changed from here — which is
            the point: a copy of the live database must not be able to declare
            itself the live site. Note that this is not APP_RUNTIME_ROLE, which
            names which container slot this is and is never read for this.
          </p>
        </div>

        <div className="space-y-1 border-t pt-4">
          <p className="text-sm font-semibold">Safer override</p>
          <p className="text-sm text-muted-foreground">
            {describeOverride(state)}
          </p>
          {state.override.updatedAt ? (
            <p className="text-xs text-muted-foreground">
              {`Last changed ${formatChangedAt(state.override.updatedAt)}`}
              {state.override.updatedByName
                ? ` by ${state.override.updatedByName}`
                : null}
            </p>
          ) : null}
        </div>

        {state.notes.length > 0 ? (
          <ul className="list-disc space-y-1 border-t pl-5 pt-4 text-sm text-muted-foreground">
            {state.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="space-y-4 rounded-md border bg-card p-6">
        {!editing ? (
          <>
            <p className="text-sm text-muted-foreground">
              {state.override.on
                ? "Switching the override off hands the decision back to this deployment's own setting. It does not make this installation the live site."
                : "Switching the override on forces this installation to be treated as a copy, whatever this deployment's setting says. Use it when you have restored a copy of the live database and want to be certain nothing reaches real members. It is stored in this database, so restoring the live database again removes it — the durable fix is APP_ENVIRONMENT_ROLE=non-production in this deployment's own environment."}
            </p>
            <Button onClick={startEditing} disabled={!state.override.readable}>
              {state.override.on
                ? "Switch the override off"
                : "Switch the override on"}
            </Button>
            {!state.override.readable ? (
              <p className="text-sm text-danger">
                The setting cannot be read, so it cannot be changed. Apply the
                pending database migrations and reload.
              </p>
            ) : null}
          </>
        ) : (
          <div className="space-y-4">
            <div className="space-y-3 rounded-md border border-warning-6 bg-warning-2 p-4">
              <p className="text-sm font-semibold">
                {target
                  ? "Force this installation to be treated as a copy"
                  : "Stop forcing this installation to be treated as a copy"}
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                <li>
                  Nothing already recorded changes. No booking, payment, member
                  or invoice is touched — what changes is how this installation
                  behaves from now on.
                </li>
                <li>
                  {target
                    ? "Once the rest of this work lands, a copy stops sending email to members and stops writing to the club's real Xero organisation."
                    : "The decision goes back to this deployment's own APP_ENVIRONMENT_ROLE setting. If that setting says nothing, this installation becomes \"not configured\" — it does NOT become the live site."}
                </li>
                <li>
                  The change is recorded in the audit log with your name and the
                  value before and after.
                </li>
              </ul>
              <div className="flex items-start gap-2">
                <Checkbox
                  id={acknowledgeId}
                  checked={acknowledged}
                  onCheckedChange={(checked) => setAcknowledged(checked)}
                />
                <Label htmlFor={acknowledgeId} className="text-sm font-normal">
                  {target
                    ? "I understand this forces the installation to be treated as a copy, and that nothing already recorded is changed."
                    : "I understand this hands the decision back to the deployment's own setting, that it does not make this installation the live site, and that nothing already recorded is changed."}
                </Label>
              </div>
            </div>

            {error ? <p className="text-sm text-danger">{error}</p> : null}

            <div className="flex gap-2">
              <Button
                onClick={() => void save()}
                disabled={!acknowledged || saving}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="outline"
                onClick={cancelEditing}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
