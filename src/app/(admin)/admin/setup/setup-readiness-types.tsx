"use client";

import { CheckCircle2, CircleAlert, CircleDashed } from "lucide-react";
import { type BadgeProps } from "@/components/ui/badge";

/**
 * What `GET /api/admin/setup` answers with, and the three presentation helpers
 * every surface that renders it shares (epic #213, C8, #223).
 *
 * Declared HERE rather than in `setup-page-client.tsx` because C8 split the
 * readiness cards out into `setup-readiness-checks.tsx` — the legacy surface
 * the wizard replaces, which renders in exactly one branch of the
 * legacy-surfaces switch. Both files need this shape, and neither should import
 * it from the other: the page would then depend on the branch it is choosing
 * between, and the cards on the page that chooses.
 *
 * Structural rather than imported from `setup-readiness.ts`, which is a SERVER
 * module and exports neither `SetupStepCheck` nor `SetupCategory`. That is the
 * same reason `setup-wizard-view.ts` declares its own copy, and the same
 * protection applies: `setup-surface-registry-parity.test.ts` fails if the
 * server's answer and what these surfaces render stop agreeing.
 */

export type SetupStatus = "complete" | "warning" | "blocked" | "not_started";
export type ProgressStatus = "open" | "completed" | "skipped";
export type Provider = "stripe" | "smtp" | "sentry" | "xero";

export interface SetupStepCheck {
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

export interface SetupCategory {
  id: string;
  title: string;
  description: string;
  status: SetupStatus;
  checks: SetupStepCheck[];
}

export interface SetupReadiness {
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

export interface SetupProgressState {
  completedStepIds: string[];
  skippedStepIds: string[];
  completedAt: string | null;
  completedByMemberId: string | null;
}

export interface SetupResponse {
  readiness: SetupReadiness;
  progress: SetupProgressState;
  /**
   * The WIZARD's percentage (D7/D14, #237 fix round) — `percentComplete` off
   * `buildSetupWizardTraversal`, computed by the route rather than derived here.
   *
   * It rides on this payload so the Progress tile can render the same number the
   * wizard's rail shows instead of deriving a second one. The tile's old
   * derivation was exactly the union D14 split apart — a passing check counted
   * as progress — so a fresh install read 56% on this page and 0% one click
   * away. See `src/app/api/admin/setup/route.ts` for why the number is computed
   * there and not in the browser.
   */
  wizardPercentComplete: number;
}

export interface ProviderTestResult {
  ok: boolean;
  provider: Provider;
  checkedAt: string;
  message: string;
}

export function statusVariant(status: SetupStatus): BadgeProps["variant"] {
  if (status === "complete") return "success";
  if (status === "blocked") return "destructive";
  if (status === "warning") return "warning";
  return "secondary";
}

export function StatusIcon({ status }: { status: SetupStatus }) {
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

export function progressLabel(progress: ProgressStatus) {
  if (progress === "completed") return "Acknowledged";
  if (progress === "skipped") return "Skipped";
  return null;
}
