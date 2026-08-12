/**
 * AI Diagnostics workspace — the shell and its readiness state (AID-7, #2378).
 *
 * WHAT IS HERE AND WHAT IS NOT. This slice is the workspace itself: admission,
 * layout, and an honest readiness state at the tier the reader has earned. The
 * conversation surface is NOT built yet, and the page says so in as many words
 * rather than presenting an empty box that looks broken. A half-built feature that
 * admits it is half-built costs an operator ten seconds; one that does not costs
 * them a support request.
 *
 * READINESS IS TIERED ON THE SERVER (owner decision Q6). `readinessForAdmin` narrows
 * the full verdict for an administrator without `support:view`, and the detailed
 * shape never reaches this component for them — it is not hidden in the markup, it
 * is not sent. See `diagnostics-readiness-tiers.ts` for why that distinction is the
 * whole point.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { guardAdminLayout } from "@/lib/admin-layout-guard";
import { getDiagnosticsReadiness } from "@/lib/ai-diagnostics-config";
import { readinessForAdmin } from "@/lib/diagnostics-readiness-tiers";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";

export const metadata = { title: "AI Diagnostics" };

export default async function DiagnosticsPage() {
  // The layout has already run this and redirected if it refused. Running it again
  // here is deliberate and cheap: a page must never depend on a parent layout having
  // gated it, because layouts and pages are separately reachable in Next's rendering
  // model and a future refactor that moves this page changes which layout wraps it.
  const guard = await guardAdminLayout();
  if (guard.outcome === "redirect") redirect(guard.destination);

  const flags = await loadEffectiveModuleFlags();
  const readiness = readinessForAdmin(
    await getDiagnosticsReadiness({ aiDiagnostics: flags.aiDiagnostics }),
    guard.permissionMatrix,
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">AI Diagnostics</h1>
        <p className="text-sm text-muted-foreground">
          Ask why a booking, member, payment or job is in the state it is in. It
          reads the system and explains; it never changes anything.
        </p>
      </header>

      <section
        aria-labelledby="diagnostics-readiness-heading"
        className="rounded-lg border border-border bg-card p-4"
      >
        <h2
          id="diagnostics-readiness-heading"
          className="text-base font-semibold"
        >
          Status
        </h2>

        {readiness.tier === "coarse" ? (
          <div className="mt-2 flex flex-col gap-2 text-sm">
            <p className="font-medium">
              {readiness.ready ? "Ready to use" : "Not ready yet"}
            </p>
            {/* The honest substitute for a blocker list: what this reader can
                actually do about it. */}
            <p className="text-muted-foreground">{readiness.whoCanResolve}</p>
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-2 text-sm">
            <p className="font-medium">
              {readiness.ready ? "Ready to use" : "Not ready yet"}
            </p>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Module</dt>
                <dd>{readiness.moduleEnabled ? "On" : "Off"}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Credential</dt>
                <dd>{readiness.keyState}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Database role</dt>
                <dd>{readiness.databaseState}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Monthly budget</dt>
                <dd>
                  {/* Integer cents throughout, formatted only at the edge. */}
                  {`$${(readiness.monthlyBudgetCents / 100).toFixed(2)}`}
                </dd>
              </div>
            </dl>
            {readiness.blockers.length > 0 && (
              <div>
                <h3 className="mt-2 text-sm font-medium">
                  What is still needed
                </h3>
                <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                  {readiness.blockers.map((blocker) => (
                    <li key={String(blocker)}>{String(blocker)}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {!readiness.moduleEnabled && (
          <p className="mt-3 text-sm">
            <Link className="underline" href="/admin/modules">
              Open Feature modules
            </Link>
          </p>
        )}
      </section>

      <section
        aria-labelledby="diagnostics-ask-heading"
        className="rounded-lg border border-dashed border-border p-4"
      >
        <h2 id="diagnostics-ask-heading" className="text-base font-semibold">
          Asking a question
        </h2>
        {/* Stated plainly rather than shown as an inert input. An empty box that
            does nothing reads as a fault; a sentence reads as a roadmap. */}
        <p className="mt-2 text-sm text-muted-foreground">
          The question and answer view is still being built. When it arrives it will
          appear here, and every answer will show where its evidence came from and
          when it was read.
        </p>
      </section>
    </div>
  );
}
