import { FinanceDashboardClient } from "@/app/(finance)/finance/_components/finance-dashboard-client";
import { buildFinanceDashboardPageModel } from "@/lib/finance-dashboard-page";
import { requireFinanceViewer } from "@/lib/finance-auth";

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
    <FinanceDashboardClient
      model={model}
      currentSearch={serializeSearchParams(resolvedSearchParams)}
    />
  );
}
