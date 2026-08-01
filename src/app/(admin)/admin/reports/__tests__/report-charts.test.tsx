// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

let activeChartData: Array<{
  label: string;
  revenueCents: number;
  tooltipLabel?: string;
}> = [];

vi.mock("recharts", () => ({
  BarChart: ({
    data,
    children,
  }: {
    data: typeof activeChartData;
    children: ReactNode;
  }) => {
    activeChartData = data;
    return <div>{children}</div>;
  },
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Tooltip: ({
    formatter,
    labelFormatter,
  }: {
    formatter: (value: number) => ReactNode[];
    labelFormatter: (
      value: string,
      payload: Array<{ payload: (typeof activeChartData)[number] }>,
    ) => ReactNode;
  }) => {
    const point = activeChartData[0];
    return (
      <div data-testid="revenue-tooltip">
        <span>{labelFormatter(point.label, [{ payload: point }])}</span>
        {formatter(point.revenueCents).map((value, index) => (
          <span key={index}>{value}</span>
        ))}
      </div>
    );
  },
  Bar: () => null,
  CartesianGrid: () => null,
  XAxis: () => null,
  YAxis: () => null,
  LineChart: () => null,
  Line: () => null,
  AreaChart: () => null,
  Area: () => null,
  PieChart: () => null,
  Pie: () => null,
  Cell: () => null,
  Legend: () => null,
}));

import { RevenueBarChart } from "@/app/(admin)/admin/reports/_components/report-charts";

describe("RevenueBarChart", () => {
  it("renders the monthly tooltip in integer cents with canonical wording", () => {
    render(
      <RevenueBarChart
        data={[
          {
            label: "Apr 2026",
            tooltipLabel: "April 2026",
            revenueCents: 3_400,
          },
        ]}
        granularity="monthly"
      />,
    );

    const tooltip = screen.getByTestId("revenue-tooltip");
    expect(tooltip).toHaveTextContent("April 2026");
    expect(tooltip).toHaveTextContent("$34");
    expect(tooltip).toHaveTextContent("Booked revenue");
  });
});
