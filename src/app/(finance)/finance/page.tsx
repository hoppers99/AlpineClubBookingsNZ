import { FinanceDashboardClient } from "@/app/(finance)/finance/_components/finance-dashboard-client";
import { FinanceReportMappingsPanel } from "@/components/admin/finance-report-mappings-panel";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { buildFinanceDashboardPageModel } from "@/lib/finance-dashboard-page";
import { requireFinanceViewer } from "@/lib/finance-auth";

/**
 * THE REPORT-MAPPING EDITOR LIVES HERE (D-C8-1; epic #213 C8, #223).
 *
 * It used to render only inside the `/admin/setup/finance` drill-down hub — one
 * of the four surfaces the legacy-surfaces switch hides — so retiring the
 * checklist would have left the club's revenue and expense report groups with
 * no editor at all. That is removing a capability rather than relocating one,
 * which D8's coverage-parity rule forbids, and the owner's decision was to move
 * it rather than to special-case the hub.
 *
 * `/finance` IS THE RIGHT HOME rather than merely an available one. It is what
 * these mappings are FOR — the report groups the dashboard's revenue and expense
 * sections are drawn from — it is where the sync-health panel's "Open report
 * mappings" link already sent operators, and it is where the wizard's
 * `finance-dashboard` step points.
 *
 * PERMISSIONS LINE UP with no widening. `requireFinanceViewer` above admits
 * `finance: view` and better; the editor's API is `finance: view` to read and
 * `finance: edit` to write, and the panel gates its own controls on
 * `finance: edit` under its own banner. So a finance viewer reads the mappings
 * and cannot change them, exactly as on the hub — and a finance-only officer,
 * who could never open the `support`-area `/admin/setup`, can now reach the
 * editor without one.
 *
 * COLLAPSED BY DEFAULT, as it was on the hub. The accordion does not mount its
 * content until it is opened, so the dashboard's own load costs nothing extra;
 * the section's `id` is what the sync-health link scrolls to.
 */

type FinanceDashboardSearchParams = Promise<
  Record<string, string | string[] | undefined>
>;

function serializeSearchParams(
  searchParams: Record<string, string | string[] | undefined> | undefined,
) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, item);
    } else if (value !== undefined) {
      params.set(key, value);
    }
  }
  return params.toString();
}

export default async function FinancePage({
  searchParams,
}: {
  searchParams?: FinanceDashboardSearchParams;
}) {
  const member = await requireFinanceViewer("/finance");
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const model = await buildFinanceDashboardPageModel({
    member,
    searchParams: resolvedSearchParams,
  });

  return (
    <div className="space-y-6">
      <FinanceDashboardClient
        model={model}
        currentSearch={serializeSearchParams(resolvedSearchParams)}
      />

      <section id="finance-report-mappings" className="space-y-3 print:hidden">
        <div>
          <h2 className="text-xl font-semibold text-foreground">
            Report mappings
          </h2>
          <p className="text-sm text-muted-foreground">
            Expand only when editing the report groups the revenue and expense
            views above are drawn from.
          </p>
        </div>
        <Accordion type="single" collapsible>
          <AccordionItem value="finance-report-mappings">
            <AccordionTrigger>Finance Report Mappings</AccordionTrigger>
            <AccordionContent>
              <FinanceReportMappingsPanel />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </section>
    </div>
  );
}
