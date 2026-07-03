"use client";

import { useEffect, useMemo, useState } from "react";

// snowhq widget payload (proxied via /api/skifield-conditions). Each area's
// live data lives under `Report`: a `Status` string plus a typed
// `ReportFields` array (temperature, snow depth, dated snowfall, and free
// text like the daily snow comment). The top-level `AreaStatus` /
// `RoadStatus` / `CurrentWeatherConditions` are section-visibility booleans,
// not data.
type SnowReportField = {
  Title?: string;
  Type?: string;
  Content?: string | null;
  Icon?: string | null;
};

type SnowFacilityType = {
  Title?: string;
  Name?: string;
  Status?: string;
  [key: string]: unknown;
};

type SnowAreaReport = {
  Status?: string;
  Issued?: string;
  ReportFields?: SnowReportField[];
  FacilityTypes?: SnowFacilityType[];
};

type SnowWidgetArea = {
  Name?: string;
  AreaName?: string;
  Title?: string;
  Status?: string;
  AreaStatus?: string;
  SnowNzWeatherPageLink?: string | null;
  Report?: SnowAreaReport | null;
  [key: string]: unknown;
};

type SnowWidgetPayload = {
  Type?: string;
  Areas?: SnowWidgetArea[];
  _error?: string;
  upstreamStatus?: number;
};

function valueText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

function displayName(area: SnowWidgetArea, index: number) {
  return (
    valueText(area.Title) ||
    valueText(area.Name) ||
    valueText(area.AreaName) ||
    `Area ${index + 1}`
  );
}

function statusTone(status: string) {
  if (/open|operating|good/i.test(status)) {
    return "bg-emerald-100 text-emerald-800";
  }
  if (/closed|hold|limited|caution|chain|warning/i.test(status)) {
    return "bg-amber-100 text-amber-800";
  }
  return "bg-slate-100 text-slate-700";
}

// Append the unit implied by a report field's type. Content is the raw
// snowhq value (e.g. "0.4" for temperature, "0" for a snow depth in cm).
function formatFieldContent(field: SnowReportField): string {
  const content = valueText(field.Content);
  if (!content) return "";
  switch (field.Type) {
    case "temperature":
      return `${content}°C`;
    case "snowdepth":
      return `${content} cm`;
    default:
      return content;
  }
}

export function SkifieldConditionsWidget({ dataHash }: { dataHash?: string }) {
  const hash = dataHash?.trim();
  const hasValidHash = Boolean(hash && /^[a-f0-9]{32}$/.test(hash));
  const [data, setData] = useState<SnowWidgetPayload | null>(null);
  const [loading, setLoading] = useState(hasValidHash);
  const [error, setError] = useState("");

  useEffect(() => {
    const requestHash = hash;
    if (!hasValidHash || !requestHash) {
      setLoading(false);
      setData(null);
      return;
    }
    const validHash = requestHash;

    let active = true;

    async function load() {
      setLoading(true);
      setError("");

      try {
        const response = await fetch(
          `/api/skifield-conditions?hash=${encodeURIComponent(validHash)}`,
          {
            method: "GET",
            cache: "no-store",
          },
        );
        const payload = (await response.json()) as SnowWidgetPayload;
        if (!active) {
          return;
        }
        setData(payload);
        setError(
          payload._error ||
            (response.ok ? "" : "Unable to load ski field conditions."),
        );
      } catch {
        if (active) {
          setData(null);
          setError("Unable to load ski field conditions.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    load();

    return () => {
      active = false;
    };
  }, [hasValidHash, hash]);

  const areas = useMemo(
    () => (Array.isArray(data?.Areas) ? data.Areas : []),
    [data],
  );

  if (!hasValidHash) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <strong>Ski field conditions widget:</strong> a 32-character hex hash is
        required. Use{" "}
        <code className="font-mono">
          {"{{skifield-conditions:your-hash-here}}"}
        </code>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
        Loading ski field conditions...
      </div>
    );
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-6">
      <div className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Ski Field Conditions
          </h2>
        </div>
      </div>

      {error ? (
        <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {error}
        </p>
      ) : null}

      {areas.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2">
          {areas.map((area, index) => {
            const report = area.Report ?? null;
            const status =
              valueText(report?.Status) ||
              valueText(area.Status) ||
              valueText(area.AreaStatus);
            const issued = valueText(report?.Issued);
            const reportFields = Array.isArray(report?.ReportFields)
              ? report!.ReportFields
              : [];
            // Split short measurements from long free-text so temperature and
            // snow depth read as a compact list and the daily comments read as
            // paragraphs. Empty (null) fields are dropped either way.
            const measurements = reportFields
              .filter((field) => field.Type !== "text")
              .map((field) => ({
                title: valueText(field.Title),
                value: formatFieldContent(field),
              }))
              .filter((field) => field.title && field.value);
            const notes = reportFields
              .filter((field) => field.Type === "text")
              .map((field) => ({
                title: valueText(field.Title),
                value: valueText(field.Content),
              }))
              .filter((field) => field.title && field.value);
            const facilities = (
              Array.isArray(report?.FacilityTypes) ? report!.FacilityTypes : []
            )
              .map((facility) => ({
                name: valueText(facility.Title) || valueText(facility.Name),
                status: valueText(facility.Status),
              }))
              .filter((facility) => facility.name);
            const link = valueText(area.SnowNzWeatherPageLink);

            return (
              <article
                key={`${displayName(area, index)}-${index}`}
                className="rounded-md border border-slate-200 bg-slate-50 p-4"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold text-slate-900">
                    {displayName(area, index)}
                  </h3>
                  {status ? (
                    <span
                      className={`inline-flex rounded-full px-2 py-1 text-xs font-medium ${statusTone(
                        status,
                      )}`}
                    >
                      {status}
                    </span>
                  ) : null}
                </div>

                {measurements.length > 0 ? (
                  <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-slate-600">
                    {measurements.map((field) => (
                      <div key={field.title}>
                        <dt className="font-medium text-slate-700">
                          {field.title}
                        </dt>
                        <dd>{field.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                {facilities.length > 0 ? (
                  <ul className="mt-3 space-y-1 text-xs text-slate-600">
                    {facilities.map((facility) => (
                      <li
                        key={facility.name}
                        className="flex items-center justify-between gap-2"
                      >
                        <span>{facility.name}</span>
                        {facility.status ? (
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${statusTone(
                              facility.status,
                            )}`}
                          >
                            {facility.status}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {notes.map((note) => (
                  <div key={note.title} className="mt-3 text-xs">
                    <p className="font-medium text-slate-700">{note.title}</p>
                    <p className="mt-1 whitespace-pre-line text-slate-600">
                      {note.value}
                    </p>
                  </div>
                ))}

                {issued ? (
                  <p className="mt-3 text-[11px] text-slate-400">
                    Issued {issued}
                  </p>
                ) : null}

                {link ? (
                  <p className="mt-2 text-xs">
                    <a
                      href={link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-brand-charcoal underline"
                    >
                      Full report on snow.nz
                    </a>
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          No ski field condition data is currently available.
        </p>
      )}
    </section>
  );
}
