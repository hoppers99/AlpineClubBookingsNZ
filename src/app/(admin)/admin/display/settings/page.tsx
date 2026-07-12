"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Per-lodge display settings (fork epic #25). The template authoring surface
// moved out with the v2 rebuild (LTV-024): the template list / JSON editor /
// copy-to-custom / preview are gone, replaced by the Layout/Template editors in
// LTV-032/033. This settings card (granularity, committee notice, {{config:key}}
// glob) stays here until LTV-035 relocates it.
//
// LTV-031: the page lives at /admin/display/settings (renamed from
// /admin/display/templates so LTV-033's Templates authoring can claim the
// /admin/display/templates path). /admin/display/templates now redirects here.

const GRANULARITY_OPTIONS = [
  { value: "", label: "Club default (first name + surname initial)" },
  { value: "FULL_NAME", label: "Full names" },
  { value: "FIRST_NAME_SURNAME_INITIAL", label: "First name + surname initial" },
  { value: "FIRST_NAME_ONLY", label: "First names only" },
  { value: "COUNTS_ONLY", label: "Counts only (no names)" },
];

export default function AdminDisplaySettingsPage() {
  const [config, setConfig] = useState<Array<{ key: string; value: string }>>([]);
  const [granularity, setGranularity] = useState<string>("");
  const [notice, setNotice] = useState<string>("");
  const [lodgeName, setLodgeName] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    const response = await fetch("/api/admin/display/lodge-config");
    if (response.ok) {
      const body = (await response.json()) as {
        lodgeName: string;
        displayConfig: Record<string, string>;
        displayNameGranularity: string | null;
        displayNotice: string | null;
      };
      setLodgeName(body.lodgeName);
      setConfig(
        Object.entries(body.displayConfig).map(([key, value]) => ({ key, value }))
      );
      setGranularity(body.displayNameGranularity ?? "");
      setNotice(body.displayNotice ?? "");
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  async function saveSettings() {
    setMessage(null);
    const displayConfig: Record<string, string> = {};
    for (const entry of config) {
      if (entry.key.trim().length === 0) continue;
      displayConfig[entry.key.trim()] = entry.value;
    }
    const response = await fetch("/api/admin/display/lodge-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayConfig,
        displayNameGranularity: granularity === "" ? null : granularity,
        displayNotice: notice.trim() === "" ? null : notice,
      }),
    });
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    setMessage(response.ok ? "Display settings saved." : body?.error ?? "Save failed");
    if (response.ok) await loadSettings();
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Display Settings</h1>
        <p className="text-muted-foreground">
          Per-lodge lobby display settings. Guest name granularity is enforced in
          the display data feed itself, so no template can show more than it
          allows.
        </p>
      </div>

      {message && <p className="text-sm font-medium">{message}</p>}

      <Card>
        <CardHeader>
          <CardTitle>
            Display settings{lodgeName ? ` — ${lodgeName}` : ""}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="granularity">Guest name display</Label>
            <select
              id="granularity"
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              value={granularity}
              onChange={(event) => setGranularity(event.target.value)}
            >
              {GRANULARITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">
              Enforced in the display data feed itself — no template can show
              more than this allows. Bookings that include children always
              collapse to a family label.
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="display-notice">Committee notice</Label>
            <textarea
              id="display-notice"
              className="border-input bg-background min-h-24 w-full rounded-md border p-3 text-sm"
              maxLength={2000}
              placeholder="A free-text notice shown by the notice module. {{config:key}} placeholders work here."
              value={notice}
              onChange={(event) => setNotice(event.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              Shown wherever a template places the notice module; leave empty to
              skip the module entirely.
            </p>
          </div>

          <div className="space-y-2">
            <Label>Config values (used as {"{{config:key}}"} in templates)</Label>
            {config.map((entry, index) => (
              <div key={index} className="flex gap-2">
                <Input
                  className="w-48"
                  placeholder="wifi-code"
                  value={entry.key}
                  onChange={(event) =>
                    setConfig((current) =>
                      current.map((row, i) =>
                        i === index ? { ...row, key: event.target.value } : row
                      )
                    )
                  }
                />
                <Input
                  className="flex-1"
                  placeholder="value"
                  value={entry.value}
                  onChange={(event) =>
                    setConfig((current) =>
                      current.map((row, i) =>
                        i === index ? { ...row, value: event.target.value } : row
                      )
                    )
                  }
                />
                <Button
                  variant="outline"
                  onClick={() =>
                    setConfig((current) => current.filter((_, i) => i !== index))
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button
              variant="outline"
              onClick={() => setConfig((current) => [...current, { key: "", value: "" }])}
            >
              Add value
            </Button>
          </div>

          <Button onClick={() => void saveSettings()}>Save display settings</Button>
        </CardContent>
      </Card>
    </div>
  );
}
