// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkifieldConditionsWidget } from "@/components/website/skifield-conditions-widget";

// Locks the mapping to the real snowhq payload shape: per-area data lives
// under `Report` (a `Status` plus a typed `ReportFields` array), not on flat
// per-area fields. Regression guard for the "renders only the area name"
// bug where the widget read fields that snowhq never sends.

const VALID_HASH = "4297a04af31a54b9b4dc710057f5a492";

// A trimmed but faithful copy of the live snowhq payload for this widget.
const SNOWHQ_PAYLOAD = {
  Type: "Small",
  AreaStatus: true,
  RoadStatus: true,
  CurrentWeatherConditions: true,
  Areas: [
    {
      Title: "Whakapapa",
      SnowNzWeatherPageLink: "https://www.snow.nz/area/nz/ruapehu/whakapapa/",
      Report: {
        Status: "Open",
        Issued: "2026-07-03 07:34:27",
        ReportFields: [
          { Title: "Temperature", Type: "temperature", Content: "0.4" },
          { Title: "Min Snow Depth", Type: "snowdepth", Content: "0" },
          { Title: "Last Snowfall", Type: "date", Content: null },
          { Title: "Weather Comment", Type: "text", Content: null },
          { Title: "Snow Comment", Type: "text", Content: "Mōrena from Whakapapa." },
        ],
        FacilityTypes: [{ Title: "Sky Waka Gondola", Status: "Open" }],
      },
    },
  ],
};

describe("SkifieldConditionsWidget", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => SNOWHQ_PAYLOAD,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the area status, typed measurements, facilities, and notes", async () => {
    render(<SkifieldConditionsWidget dataHash={VALID_HASH} />);

    // Area name and its Report.Status badge (the facility below is also
    // "Open", so both the area status and the facility status match).
    expect(await screen.findByText("Whakapapa")).toBeTruthy();
    expect(screen.getAllByText("Open").length).toBeGreaterThanOrEqual(1);

    // Typed measurements gain their unit; null fields are dropped.
    expect(screen.getByText("0.4°C")).toBeTruthy();
    expect(screen.getByText("0 cm")).toBeTruthy();
    expect(screen.queryByText("Last Snowfall")).toBeNull();
    expect(screen.queryByText("Weather Comment")).toBeNull();

    // Free-text notes and facility statuses render.
    expect(screen.getByText("Snow Comment")).toBeTruthy();
    expect(screen.getByText("Mōrena from Whakapapa.")).toBeTruthy();
    expect(screen.getByText("Sky Waka Gondola")).toBeTruthy();
  });

  it("rejects an invalid hash without fetching", () => {
    render(<SkifieldConditionsWidget dataHash="not-a-valid-hash" />);
    expect(
      screen.getByText(/32-character hex hash is required/i),
    ).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows the empty state when snowhq returns no areas", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ Type: "Small", Areas: [] }),
    });
    render(<SkifieldConditionsWidget dataHash={VALID_HASH} />);
    await waitFor(() =>
      expect(
        screen.getByText(/No ski field condition data is currently available/i),
      ).toBeTruthy(),
    );
  });
});
