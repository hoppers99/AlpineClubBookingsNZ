"use client";

import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  PlayCircle,
  RotateCcw,
  SkipForward,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SetupStepLinks } from "@/components/admin/setup-step-links";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  StatusIcon,
  progressLabel,
  statusVariant,
  type Provider,
  type ProviderTestResult,
  type SetupCategory,
} from "./setup-readiness-types";

/**
 * The readiness cards (epic #213, C8, #223).
 *
 * LIFTED OUT OF `setup-page-client.tsx` rather than rewritten. This is the
 * legacy surface the wizard replaces: it renders in exactly one branch — the
 * legacy-surfaces switch's SHOWN position — so keeping it inside the page
 * component meant a hundred and fifty lines that the hidden position never
 * reaches sitting in the middle of the page that decides between them, and put
 * that file over its size budget for the first time.
 *
 * It derives nothing. Every verdict, every step id and every action arrives
 * from the readiness payload the page already loaded, which is the single
 * derivation #223 exists to enforce.
 */
export function SetupReadinessChecks({
  categories,
  providerResults,
  savingStep,
  runningProvider,
  onProviderTest,
  onProgress,
}: {
  categories: SetupCategory[];
  providerResults: Record<string, ProviderTestResult>;
  savingStep: string | null;
  runningProvider: Provider | null;
  onProviderTest: (provider: Provider) => void;
  onProgress: (action: "complete" | "skip" | "reopen", stepId: string) => void;
}) {
  return (
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
      {categories.map((category) => (
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
                          onClick={() => onProviderTest(check.action!.provider)}
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
                          onClick={() => onProgress("complete", check.id)}
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
                          onClick={() => onProgress("skip", check.id)}
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
                          onClick={() => onProgress("reopen", check.id)}
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
  );
}
