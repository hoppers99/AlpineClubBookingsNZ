"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayTemplateDefinition } from "@/lib/lodge-display/template-registry";
import { eligibleDisplayPanels } from "@/lib/lodge-display/template-registry";
import { DISPLAY_MODULE_COMPONENTS } from "@/components/lodge-display/modules";

// Display templates + per-lodge display settings (fork issue #34, epic #25).
// Templates: list the registry, copy a template to a CUSTOM row, edit the
// definition as JSON (validated server-side against the closed registries —
// ADR-002), preview with live data through the SAME privacy-reduced
// serialiser the real display uses. Settings: the {{config:<key>}} glob and
// the name-granularity override per lodge.

interface TemplateOption {
  key: string;
  name: string;
  source: string;
}

const GRANULARITY_OPTIONS = [
  { value: "", label: "Club default (first name + surname initial)" },
  { value: "FULL_NAME", label: "Full names" },
  { value: "FIRST_NAME_SURNAME_INITIAL", label: "First name + surname initial" },
  { value: "FIRST_NAME_ONLY", label: "First names only" },
  { value: "COUNTS_ONLY", label: "Counts only (no names)" },
];

function PreviewPane({
  template,
  state,
}: {
  template: DisplayTemplateDefinition;
  state: DisplayState;
}) {
  return (
    <div className="rounded-md border bg-black/90 p-3 text-white">
      {template.regions.map((region) => {
        const panels = eligibleDisplayPanels(region, state);
        const panel = panels[0];
        const Module = panel
          ? DISPLAY_MODULE_COMPONENTS[
              panel.module as keyof typeof DISPLAY_MODULE_COMPONENTS
            ]
          : undefined;
        return (
          <div key={region.key} className="mb-2 border-b border-white/10 pb-2 last:border-b-0">
            <p className="text-xs uppercase tracking-wide text-white/50">
              {region.key}
              {panels.length > 1 ? ` · rotates ${panels.length} panels` : ""}
            </p>
            {panel ? (
              Module ? (
                <div className="display-preview-scope text-sm">
                  <Module state={state} options={panel.options} />
                </div>
              ) : (
                <p className="text-sm text-white/60">[{panel.module}]</p>
              )
            ) : (
              <p className="text-sm text-white/40">No eligible panel for current data</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function AdminDisplayTemplatesPage() {
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [selectedSource, setSelectedSource] = useState<string>("");
  const [editorJson, setEditorJson] = useState<string>("");
  const [preview, setPreview] = useState<{
    template: DisplayTemplateDefinition;
    state: DisplayState;
  } | null>(null);
  const [copyKey, setCopyKey] = useState("");
  const [copyName, setCopyName] = useState("");
  const [config, setConfig] = useState<Array<{ key: string; value: string }>>([]);
  const [granularity, setGranularity] = useState<string>("");
  const [lodgeName, setLodgeName] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);

  const refreshTemplates = useCallback(async () => {
    const response = await fetch("/api/admin/display/templates");
    if (response.ok) {
      const body = (await response.json()) as { templates: TemplateOption[] };
      setTemplates(body.templates);
    }
  }, []);

  const loadSettings = useCallback(async () => {
    const response = await fetch("/api/admin/display/lodge-config");
    if (response.ok) {
      const body = (await response.json()) as {
        lodgeName: string;
        displayConfig: Record<string, string>;
        displayNameGranularity: string | null;
      };
      setLodgeName(body.lodgeName);
      setConfig(
        Object.entries(body.displayConfig).map(([key, value]) => ({ key, value }))
      );
      setGranularity(body.displayNameGranularity ?? "");
    }
  }, []);

  useEffect(() => {
    void refreshTemplates();
    void loadSettings();
  }, [refreshTemplates, loadSettings]);

  async function selectTemplate(key: string) {
    setMessage(null);
    setSelectedKey(key);
    setPreview(null);
    const response = await fetch(`/api/admin/display/templates/${key}`);
    if (response.ok) {
      const body = (await response.json()) as {
        template: DisplayTemplateDefinition;
        source: string;
      };
      setSelectedSource(body.source);
      setEditorJson(JSON.stringify(body.template, null, 2));
    }
  }

  async function saveTemplate() {
    setMessage(null);
    let definition: unknown;
    try {
      definition = JSON.parse(editorJson);
    } catch {
      setMessage("The definition is not valid JSON.");
      return;
    }
    const response = await fetch(`/api/admin/display/templates/${selectedKey}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ definition }),
    });
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    setMessage(response.ok ? "Template saved." : body?.error ?? "Save failed");
    if (response.ok) await refreshTemplates();
  }

  async function deleteStored() {
    setMessage(null);
    const response = await fetch(`/api/admin/display/templates/${selectedKey}`, {
      method: "DELETE",
    });
    setMessage(
      response.ok
        ? "Stored template removed (built-ins revert to the code default)."
        : "Delete failed"
    );
    if (response.ok) {
      await refreshTemplates();
      await selectTemplate(selectedKey).catch(() => setSelectedKey(""));
    }
  }

  async function copyToCustom() {
    setMessage(null);
    const response = await fetch("/api/admin/display/templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fromKey: selectedKey, key: copyKey, name: copyName }),
    });
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    setMessage(response.ok ? "Custom template created." : body?.error ?? "Copy failed");
    if (response.ok) {
      setCopyKey("");
      setCopyName("");
      await refreshTemplates();
    }
  }

  async function loadPreview() {
    setMessage(null);
    const response = await fetch(
      `/api/admin/display/preview?templateKey=${encodeURIComponent(selectedKey)}`
    );
    if (response.ok) {
      setPreview(
        (await response.json()) as {
          template: DisplayTemplateDefinition;
          state: DisplayState;
        }
      );
    } else {
      setMessage("Preview failed");
    }
  }

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
      }),
    });
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    setMessage(response.ok ? "Display settings saved." : body?.error ?? "Save failed");
    if (response.ok) await loadSettings();
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Display Templates</h1>
        <p className="text-muted-foreground">
          Built-in templates ship with the software; copy one to customise it,
          or edit a custom template directly. Definitions are validated — an
          unknown module or condition is rejected, never rendered broken.
        </p>
      </div>

      {message && <p className="text-sm font-medium">{message}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Templates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {templates.map((template) => (
              <Button
                key={template.key}
                variant={template.key === selectedKey ? "default" : "outline"}
                onClick={() => void selectTemplate(template.key)}
              >
                {template.name}
                <Badge variant="secondary" className="ml-2">
                  {template.source}
                </Badge>
              </Button>
            ))}
          </div>

          {selectedKey && (
            <div className="space-y-3">
              <Label htmlFor="template-editor">
                Definition ({selectedKey} · {selectedSource})
              </Label>
              <textarea
                id="template-editor"
                className="border-input bg-background min-h-64 w-full rounded-md border p-3 font-mono text-xs"
                value={editorJson}
                onChange={(event) => setEditorJson(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void saveTemplate()}>Save</Button>
                {selectedSource !== "built-in" && (
                  <Button variant="destructive" onClick={() => void deleteStored()}>
                    {selectedSource === "override" ? "Remove override" : "Delete custom"}
                  </Button>
                )}
                <Button variant="outline" onClick={() => void loadPreview()}>
                  Preview with live data
                </Button>
                <div className="flex items-end gap-2">
                  <div>
                    <Label htmlFor="copy-key" className="text-xs">
                      New key
                    </Label>
                    <Input
                      id="copy-key"
                      className="w-40"
                      placeholder="our-foyer"
                      value={copyKey}
                      onChange={(event) => setCopyKey(event.target.value)}
                    />
                  </div>
                  <div>
                    <Label htmlFor="copy-name" className="text-xs">
                      New name
                    </Label>
                    <Input
                      id="copy-name"
                      className="w-40"
                      placeholder="Our foyer"
                      value={copyName}
                      onChange={(event) => setCopyName(event.target.value)}
                    />
                  </div>
                  <Button
                    variant="outline"
                    disabled={!copyKey || !copyName}
                    onClick={() => void copyToCustom()}
                  >
                    Copy to custom
                  </Button>
                </div>
              </div>
              {preview && <PreviewPane template={preview.template} state={preview.state} />}
            </div>
          )}
        </CardContent>
      </Card>

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
