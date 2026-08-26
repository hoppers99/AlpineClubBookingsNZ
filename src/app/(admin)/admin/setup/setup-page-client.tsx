"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  ExternalLink,
  Loader2,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  SkipForward,
  Wand2,
} from "lucide-react";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SetupStepLinks } from "@/components/admin/setup-step-links";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { LodgeCapacityCard } from "@/components/admin/lodge-capacity-card";
import type { FeatureFlags } from "@/config/schema";
import type { AdminPermissionMatrix } from "@/lib/admin-permissions";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  SETUP_HUB_CARDS,
  getVisibleSetupHubCards,
} from "./setup-hub-cards";
import { SetupSurfacesSection } from "./setup-surfaces-section";

type SetupStatus = "complete" | "warning" | "blocked" | "not_started";
type ProgressStatus = "open" | "completed" | "skipped";
type Provider = "stripe" | "smtp" | "sentry" | "xero";

interface SetupStepCheck {
  id: string;
  title: string;
  description: string;
  status: SetupStatus;
  required: boolean;
  message: string;
  details: string[];
  href?: string;
  links?: { label: string; href: string }[];
  progress: ProgressStatus;
  action?: {
    type: "provider-test";
    provider: Provider;
    label: string;
  };
}

interface SetupCategory {
  id: string;
  title: string;
  description: string;
  status: SetupStatus;
  checks: SetupStepCheck[];
}

interface SetupReadiness {
  status: SetupStatus;
  summary: {
    total: number;
    complete: number;
    warning: number;
    blocked: number;
    skipped: number;
  };
  categories: SetupCategory[];
  generatedAt: string;
}

interface SetupProgressState {
  completedStepIds: string[];
  skippedStepIds: string[];
  completedAt: string | null;
  completedByMemberId: string | null;
}

interface SetupResponse {
  readiness: SetupReadiness;
  progress: SetupProgressState;
}

interface ProviderTestResult {
  ok: boolean;
  provider: Provider;
  checkedAt: string;
  message: string;
}

function responseErrorMessage(body: unknown, fallback: string) {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return fallback;
}

function statusVariant(status: SetupStatus): BadgeProps["variant"] {
  if (status === "complete") return "success";
  if (status === "blocked") return "destructive";
  if (status === "warning") return "warning";
  return "secondary";
}

function StatusIcon({ status }: { status: SetupStatus }) {
  if (status === "complete") {
    return <CheckCircle2 className="h-4 w-4 text-success-11" />;
  }
  if (status === "blocked") {
    return <CircleAlert className="h-4 w-4 text-danger-11" />;
  }
  if (status === "warning") {
    return <CircleAlert className="h-4 w-4 text-warning-11" />;
  }
  return <CircleDashed className="h-4 w-4 text-muted-foreground" />;
}

function progressLabel(progress: ProgressStatus) {
  if (progress === "completed") return "Acknowledged";
  if (progress === "skipped") return "Skipped";
  return null;
}

function SetupHubCards({
  features,
  permissionMatrix,
  applicableStepIds,
  legacySurfacesHidden,
}: {
  features: FeatureFlags;
  permissionMatrix: AdminPermissionMatrix;
  applicableStepIds: ReadonlySet<string>;
  legacySurfacesHidden: boolean;
}) {
  const visibleCards = getVisibleSetupHubCards(
    SETUP_HUB_CARDS,
    features,
    permissionMatrix,
    applicableStepIds,
    legacySurfacesHidden,
  );

  if (visibleCards.length === 0) return null;

  return (
    <section id="setup-hubs" className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold text-foreground">Setup hubs</h2>
        <p className="text-sm text-muted-foreground">
          Open the relevant drill-down before editing lower-frequency
          configuration.
        </p>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {visibleCards.map(({ href, title, description, icon: Icon }) => (
          <Link key={href} href={href} className="group block">
            <Card className="h-full transition-colors hover:border-brand-gold/70">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <Icon className="h-5 w-5 shrink-0 text-foreground" />
                  <CardTitle className="text-base">{title}</CardTitle>
                </div>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

export function SetupPageClient({
  permissionMatrix,
  features,
  legacySurfacesHidden: initialLegacySurfacesHidden,
}: {
  permissionMatrix: AdminPermissionMatrix;
  features: FeatureFlags;
  /**
   * Epic #213, C8 (#223). The SERVER's answer, so nothing renders for a frame
   * and then vanishes. Held in state below only so the settings section can
   * update it in place after a save.
   */
  legacySurfacesHidden: boolean;
}) {
  const [legacySurfacesHidden, setLegacySurfacesHidden] = useState(
    initialLegacySurfacesHidden,
  );
  // Tri-state, so the resolving `undefined` window renders neither an enabled
  // control nor a view-only banner (#2065). `support` is the area this page and
  // the surfaces route both enforce.
  const canEditSupport = useAdminAreaEditAccess("support");
  const [readiness, setReadiness] = useState<SetupReadiness | null>(null);
  const [progress, setProgress] = useState<SetupProgressState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [savingStep, setSavingStep] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [runningProvider, setRunningProvider] = useState<Provider | null>(null);
  const [providerResults, setProviderResults] = useState<Record<string, ProviderTestResult>>({});

  async function loadSetup() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/admin/setup", {
        credentials: "same-origin",
      });
      const body = (await response.json()) as SetupResponse | { error?: string };
      if (!response.ok || !("readiness" in body)) {
        throw new Error(responseErrorMessage(body, "Failed to load setup readiness"));
      }
      setReadiness(body.readiness);
      setProgress(body.progress);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Failed to load setup readiness",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSetup();
  }, []);

  const allChecks = useMemo(
    () => readiness?.categories.flatMap((category) => category.checks) ?? [],
    [readiness],
  );
  /*
    The registry's applicable set, as the server derived it (epic #213, C8
    #223). `buildSetupReadiness` now filters its checks through
    `getApplicableSetupStepIds`, so the ids of the checks that came back ARE the
    applicable set — there is nothing to recompute here, and recomputing it
    client-side is precisely the second derivation this issue exists to remove.
  */
  const applicableStepIds = useMemo(
    () => new Set(allChecks.map((check) => check.id)),
    [allChecks],
  );
  const requiredBlockers = allChecks.filter(
    (check) =>
      check.required &&
      check.status === "blocked" &&
      check.progress !== "skipped",
  );
  const completedSteps = allChecks.filter(
    (check) => check.status === "complete" || check.progress === "completed",
  ).length;
  const completionPercent =
    allChecks.length > 0 ? Math.round((completedSteps / allChecks.length) * 100) : 0;
  const setupCompleted = Boolean(progress?.completedAt);
  const overallStatus = setupCompleted ? "complete" : readiness?.status ?? "not_started";

  async function updateProgress(
    action: "complete" | "skip" | "reopen",
    stepId: string,
  ) {
    setSavingStep(stepId);
    setError("");
    try {
      const response = await fetch("/api/admin/setup/progress", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, stepId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to update setup progress");
      }
      await loadSetup();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Failed to update setup progress",
      );
    } finally {
      setSavingStep(null);
    }
  }

  async function finishSetup() {
    setFinishing(true);
    setError("");
    try {
      const response = await fetch("/api/admin/setup/progress", {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "finish" }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(body?.error ?? "Failed to finish setup");
      }
      await loadSetup();
    } catch (finishError) {
      setError(
        finishError instanceof Error ? finishError.message : "Failed to finish setup",
      );
    } finally {
      setFinishing(false);
    }
  }

  async function runProviderTest(provider: Provider) {
    setRunningProvider(provider);
    setError("");
    try {
      const response = await fetch("/api/admin/setup/provider-test", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      const body = (await response.json()) as ProviderTestResult | { error?: string };
      if (!response.ok || !("ok" in body)) {
        throw new Error(responseErrorMessage(body, "Provider test failed"));
      }
      setProviderResults((current) => ({
        ...current,
        [provider]: body,
      }));
      await loadSetup();
    } catch (providerError) {
      setProviderResults((current) => ({
        ...current,
        [provider]: {
          ok: false,
          provider,
          checkedAt: new Date().toISOString(),
          message:
            providerError instanceof Error
              ? providerError.message
              : "Provider test failed",
        },
      }));
    } finally {
      setRunningProvider(null);
    }
  }

  if (loading && !readiness) {
    return (
      <div className="flex min-h-[320px] items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading setup readiness
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        {/*
          THE PAGE SAYS WHAT IT IS IN THE POSITION IT IS IN (#223 fix round).
          With the surfaces hidden there is no checklist on this page, so an h1
          reading "Setup checklist" over a page holding a wizard link, three hub
          cards and a settings section describes something that is not there.
        */}
        <div>
          <h1 className="text-3xl font-bold text-foreground">
            {legacySurfacesHidden ? "Setup" : "Setup checklist"}
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            {legacySurfacesHidden
              ? "The setup wizard walks the club's configuration; what is outstanding, and how far through you are, live there. This page keeps the way in, the areas the wizard does not cover, and the switch that brings the older checklist back."
              : "Finish first-install readiness for club configuration, booking rules, provider connections, and finance mappings."}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {/*
            The wizard launcher (epic #213, C5). Per D6 the readiness cards below
            are UNCHANGED and stay — the wizard ships alongside them first, and
            C8 (#223) owns the transition to replacing them. This is deliberately
            only an entry point: it resumes at whatever step the wizard's own
            traversal calls current, so an operator who left halfway picks up
            where they were rather than at the top.
          */}
          <Button asChild>
            <Link href="/admin/setup/wizard">
              <Wand2 className="h-4 w-4" />
              Open the setup wizard
            </Link>
          </Button>
          <Button variant="outline" onClick={loadSetup} disabled={loading}>
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
          {/*
            MARK SETUP COMPLETE STAYS IN BOTH POSITIONS, and that is D8's parity
            rule applied honestly rather than timidity (#223 fix round).

            It is easy to assume the wizard's launch panel replaced it. It did
            not: the panel publishes the PUBLIC SITE — the club theme's
            `completedAt`, through `POST /api/admin/site-style/complete-setup` —
            while this button finishes the SETUP JOURNEY, `SetupProgress.
            completedAt`, through `PATCH /api/admin/setup/progress`. Two
            columns, two APIs, two meanings, and the journey one has a real
            consumer: `config-transfer/bootstrap-import.ts` counts it to decide
            whether this installation has ever been set up.

            So the wizard offers no equivalent, and hiding this with the
            checklist would REMOVE a capability rather than relocate one. If a
            later child gives the wizard a "finish the journey" control, this is
            the button that retires with the rest of the surfaces.
          */}
          <Button
            onClick={finishSetup}
            disabled={
              finishing || setupCompleted || requiredBlockers.length > 0 || !readiness
            }
          >
            {finishing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4" />
            )}
            {setupCompleted ? "Setup Complete" : "Mark Setup Complete"}
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-danger-6 bg-danger-3 px-4 py-3 text-sm text-danger-11">
          {error}
        </div>
      ) : null}

      {setupCompleted ? (
        <div className="rounded-md border border-success-6 bg-success-3 px-4 py-3 text-sm text-success-11">
          Setup has been marked complete.
        </div>
      ) : null}

      {readiness ? (
        <>
          {/*
            THE KPI TILES ARE CHECKLIST CHROME AND GO WITH IT (#223 fix round).
            Overall, Progress, Blocked and Skipped are four summaries of the
            cards immediately below them; with the cards hidden they were a
            standing report on a list that is not on the page, and a SECOND
            progress display competing with the wizard's own rail — which D7
            makes the single derivation. The wizard owns progress; this page
            owns the way in.
          */}
          {legacySurfacesHidden ? null : (
            <div className="grid gap-3 md:grid-cols-4" data-testid="setup-kpis">
              <div className="rounded-md border bg-card p-4">
                <div className="flex items-center gap-2">
                  <StatusIcon status={overallStatus} />
                  <p className="text-sm font-medium text-muted-foreground">Overall</p>
                </div>
                <p className="mt-2 text-2xl font-semibold capitalize text-foreground">
                  {overallStatus.replace("_", " ")}
                </p>
              </div>
              <div className="rounded-md border bg-card p-4">
                <p className="text-sm font-medium text-muted-foreground">Progress</p>
                <p className="mt-2 text-2xl font-semibold text-foreground">
                  {completionPercent}%
                </p>
              </div>
              <div className="rounded-md border bg-card p-4">
                <p className="text-sm font-medium text-muted-foreground">Blocked</p>
                <p className="mt-2 text-2xl font-semibold text-foreground">
                  {readiness.summary.blocked}
                </p>
              </div>
              <div className="rounded-md border bg-card p-4">
                <p className="text-sm font-medium text-muted-foreground">Skipped</p>
                <p className="mt-2 text-2xl font-semibold text-foreground">
                  {readiness.summary.skipped}
                </p>
              </div>
            </div>
          )}

          {/*
            THE BLOCKER NOTICE STAYS IN BOTH POSITIONS, and its wording moves
            with them. It is not a summary of the cards — it is the disabled
            REASON for Mark Setup Complete above, which stays (see the header),
            so hiding it would leave a dead button explaining nothing. What
            changes is where it sends you: with the checklist gone, the steps
            are resolved or skipped in the wizard.
          */}
          {requiredBlockers.length > 0 ? (
            <div className="rounded-md border border-warning-6 bg-warning-3 px-4 py-3 text-sm text-warning-11">
              {legacySurfacesHidden
                ? "Some required steps are still blocked. Resolve them in the setup wizard, or skip them there, before marking setup complete."
                : "Resolve or explicitly skip required blocked steps before marking setup complete."}
            </div>
          ) : null}

          {/*
            Not hidden wholesale: `getVisibleSetupHubCards` retires the FOUR
            hubs the wizard replaces and leaves Membership & Members,
            Cancellation and Email Messages / Notifications in place, because
            the wizard offers no route to those and dropping them would remove a
            capability rather than relocate one (D8 cuts both ways).
          */}
          <SetupHubCards
            features={features}
            permissionMatrix={permissionMatrix}
            applicableStepIds={applicableStepIds}
            legacySurfacesHidden={legacySurfacesHidden}
          />

          {/* The lodge-capacity card remains on the setup page and keeps the
              #1548 matrix gate because its backing API is lodge-area while
              /admin/setup itself is support-area. It is NOT a legacy setup
              surface — it reports live lodge capacity rather than setup
              readiness, the wizard never offered it, and hiding it with the
              cards would remove a capability instead of relocating one (D8's
              coverage-parity rule cuts both ways). */}
          {permissionMatrix.lodge !== "none" ? <LodgeCapacityCard /> : null}

          {legacySurfacesHidden ? (
            /*
              Epic #213 D8, executed. The readiness cards and the hub links are
              absent — not deleted, and not made unreachable. Every destination
              they opened is a step of the wizard, so this says where they went
              rather than leaving a page that looks broken. `role="status"` is
              deliberately NOT used: this is ordinary standing page content, not
              an announcement.
            */
            <div
              className="rounded-md border bg-card px-4 py-3 text-sm text-muted-foreground"
              data-testid="setup-surfaces-hidden-notice"
            >
              The readiness checklist and the Initial Setup, Finance, Booking
              Rules and Operational Integrations hubs are hidden for this club.
              Everything they opened is a step of the setup wizard — open it
              above to work through what is outstanding, and to see how far
              through the club is. Finance&apos;s report mappings live on the
              finance dashboard. You can bring the older surfaces back under{" "}
              <span className="font-medium">Setup surfaces</span> at the foot of
              this page.
            </div>
          ) : (
          <section id="setup-checks" className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold text-foreground">
                Readiness checks
              </h2>
              <p className="text-sm text-muted-foreground">
                Work through the live checks after choosing the matching setup
                hub.
              </p>
            </div>
            {readiness.categories.map((category) => (
              <section key={category.id} className="space-y-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-foreground">
                      {category.title}
                    </h2>
                    <p className="text-sm text-muted-foreground">{category.description}</p>
                  </div>
                  <Badge variant={statusVariant(category.status)} className="w-fit capitalize">
                    {category.status.replace("_", " ")}
                  </Badge>
                </div>

                <div className="grid gap-3 xl:grid-cols-2">
                  {category.checks.map((check) => {
                    const result = check.action
                      ? providerResults[check.action.provider]
                      : null;
                    const progress = progressLabel(check.progress);
                    const isSaving = savingStep === check.id;
                    return (
                      <Card key={check.id}>
                        <CardHeader className="space-y-3">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="flex gap-3">
                              <StatusIcon status={check.status} />
                              <div>
                                <CardTitle className="text-base">
                                  {check.title}
                                </CardTitle>
                                <CardDescription>{check.description}</CardDescription>
                              </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <Badge variant={statusVariant(check.status)} className="capitalize">
                                {check.status.replace("_", " ")}
                              </Badge>
                              {check.required ? (
                                <Badge variant="outline">Required</Badge>
                              ) : null}
                              {progress ? (
                                <Badge variant="secondary">{progress}</Badge>
                              ) : null}
                            </div>
                          </div>
                        </CardHeader>
                        <CardContent className="space-y-4">
                          <p className="text-sm text-muted-foreground">{check.message}</p>
                          {check.details.length > 0 ? (
                            <ul className="space-y-1 text-sm text-muted-foreground">
                              {check.details.map((detail) => (
                                <li key={detail}>{detail}</li>
                              ))}
                            </ul>
                          ) : null}
                          <SetupStepLinks links={check.links} />

                          {result ? (
                            <div
                              className={`rounded-md border px-3 py-2 text-sm ${
                                result.ok
                                  ? "border-success-6 bg-success-3 text-success-11"
                                  : "border-danger-6 bg-danger-3 text-danger-11"
                              }`}
                            >
                              {result.message}
                            </div>
                          ) : null}

                          <div className="flex flex-wrap gap-2">
                            {check.href ? (
                              <Button asChild variant="outline" size="sm">
                                <a href={check.href}>
                                  <ExternalLink className="h-4 w-4" />
                                  Open
                                </a>
                              </Button>
                            ) : null}
                            {check.action ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => runProviderTest(check.action!.provider)}
                                disabled={runningProvider === check.action.provider}
                              >
                                {runningProvider === check.action.provider ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <PlayCircle className="h-4 w-4" />
                                )}
                                {check.action.label}
                              </Button>
                            ) : null}
                            {check.progress !== "completed" ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => updateProgress("complete", check.id)}
                                disabled={isSaving}
                              >
                                {isSaving ? (
                                  <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                  <CheckCircle2 className="h-4 w-4" />
                                )}
                                Acknowledge
                              </Button>
                            ) : null}
                            {check.progress !== "skipped" ? (
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => updateProgress("skip", check.id)}
                                disabled={isSaving}
                              >
                                <SkipForward className="h-4 w-4" />
                                Skip
                              </Button>
                            ) : null}
                            {check.progress !== "open" ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => updateProgress("reopen", check.id)}
                                disabled={isSaving}
                              >
                                <RotateCcw className="h-4 w-4" />
                                Reopen
                              </Button>
                            ) : null}
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </section>
            ))}
          </section>
          )}
        </>
      ) : null}

      {/*
        Rendered in EVERY state — outside the `readiness ? … : null` branch
        above, and outside the hidden/shown branch inside it. That is the whole
        placement argument (epic #213, C8 #223): the switch that hides the
        surfaces has to stay where the surfaces were, or hiding them makes it
        unreachable. It therefore survives a failed readiness load too, which is
        exactly the state somebody might be trying to escape.
      */}
      <SetupSurfacesSection
        canEdit={canEditSupport}
        onSaved={(settings) =>
          setLegacySurfacesHidden(settings.legacySurfacesHidden)
        }
      />
    </div>
  );
}
