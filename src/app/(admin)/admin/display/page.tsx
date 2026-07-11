"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Lobby display device management (fork issue #33, epic #25): list devices
// with pairing/last-seen state, create a device, arm pairing by entering the
// code shown on the TV (ADR-001 admin bind), assign a registry template,
// revoke. The lobbyDisplay module flag gates this page at the proxy.

interface ClientDevice {
  id: string;
  name: string;
  lodgeId: string;
  lodgeName: string;
  templateKey: string | null;
  paired: boolean;
  pairingArmedUntil: string | null;
  lastSeenAt: string | null;
  revoked: boolean;
}

interface TemplateOption {
  key: string;
  name: string;
  source: string;
}

interface LodgeOption {
  id: string;
  name: string;
}

export default function AdminDisplayPage() {
  const [devices, setDevices] = useState<ClientDevice[]>([]);
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [lodges, setLodges] = useState<LodgeOption[]>([]);
  const [newName, setNewName] = useState("");
  const [newLodgeId, setNewLodgeId] = useState("");
  const [codeByDevice, setCodeByDevice] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [displayUrl, setDisplayUrl] = useState("/display");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setDisplayUrl(`${window.location.origin}/display`);
  }, []);

  const refresh = useCallback(async () => {
    const [devicesRes, templatesRes, lodgesRes] = await Promise.all([
      fetch("/api/admin/display/devices"),
      fetch("/api/admin/display/templates"),
      fetch("/api/admin/lodges").catch(() => null),
    ]);
    if (devicesRes.ok) {
      const body = (await devicesRes.json()) as { devices: ClientDevice[] };
      setDevices(body.devices);
    }
    if (templatesRes.ok) {
      const body = (await templatesRes.json()) as { templates: TemplateOption[] };
      setTemplates(body.templates);
    }
    if (lodgesRes?.ok) {
      const body = (await lodgesRes.json()) as {
        lodges?: Array<{ id: string; name: string; active?: boolean }>;
      };
      const active = (body.lodges ?? []).filter((lodge) => lodge.active !== false);
      setLodges(active.map((lodge) => ({ id: lodge.id, name: lodge.name })));
      setNewLodgeId((current) => current || active[0]?.id || "");
    }
    // A single-lodge club (multiLodge off) has no lodges endpoint: creation
    // falls back to the club's default lodge server-side.
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function createDevice() {
    setMessage(null);
    const response = await fetch("/api/admin/display/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName, ...(newLodgeId ? { lodgeId: newLodgeId } : {}) }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage(body?.error ?? "Could not create the device");
      return;
    }
    setNewName("");
    await refresh();
  }

  async function armPairing(deviceId: string) {
    setMessage(null);
    const code = codeByDevice[deviceId] ?? "";
    const response = await fetch(`/api/admin/display/devices/${deviceId}/pairing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const body = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string }
      | null;
    setMessage(
      response.ok
        ? "Pairing armed — the display will connect within a few seconds."
        : body?.error ?? "Pairing failed"
    );
    if (response.ok) {
      setCodeByDevice((current) => ({ ...current, [deviceId]: "" }));
      await refresh();
    }
  }

  async function assignTemplate(deviceId: string, templateKey: string) {
    setMessage(null);
    const response = await fetch(`/api/admin/display/devices/${deviceId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ templateKey: templateKey || null }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      setMessage(body?.error ?? "Could not assign the template");
      return;
    }
    await refresh();
  }

  async function revoke(deviceId: string) {
    setMessage(null);
    const response = await fetch(`/api/admin/display/devices/${deviceId}/revoke`, {
      method: "POST",
    });
    if (!response.ok) {
      setMessage("Could not revoke the device");
      return;
    }
    await refresh();
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">Lobby Display</h1>
        <p className="text-muted-foreground">
          Paired lobby screens per lodge. Create a device, open the display URL
          on the TV, then enter the code it shows to pair. Devices are
          read-only and individually revocable.
        </p>
      </div>

      {message && <p className="text-sm font-medium">{message}</p>}

      <Card>
        <CardHeader>
          <CardTitle>Setting up a screen</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            1. On the TV (or any browser on the screen device), open:{" "}
            <code className="bg-muted rounded px-2 py-1 font-mono">{displayUrl}</code>{" "}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(displayUrl).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
            >
              {copied ? "Copied" : "Copy URL"}
            </Button>
          </p>
          <p>2. The screen shows a six-character pairing code.</p>
          <p>
            3. Create (or pick) a device below, type the code into its Pair box,
            and the screen connects itself within a few seconds. It keeps
            working across reboots until you revoke it.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add a display device</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="device-name">Name</Label>
            <Input
              id="device-name"
              value={newName}
              placeholder="Lobby TV"
              onChange={(event) => setNewName(event.target.value)}
            />
          </div>
          {lodges.length > 1 && (
            <div className="space-y-1">
              <Label htmlFor="device-lodge">Lodge</Label>
              <select
                id="device-lodge"
                className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                value={newLodgeId}
                onChange={(event) => setNewLodgeId(event.target.value)}
              >
                {lodges.map((lodge) => (
                  <option key={lodge.id} value={lodge.id}>
                    {lodge.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <Button onClick={() => void createDevice()} disabled={!newName}>
            Create device
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Devices</CardTitle>
        </CardHeader>
        <CardContent>
          {loading && <p className="text-muted-foreground text-sm">Loading…</p>}
          {!loading && devices.length === 0 && (
            <p className="text-muted-foreground text-sm">No display devices yet.</p>
          )}
          <div className="space-y-4">
            {devices.map((device) => (
              <div
                key={device.id}
                className="flex flex-wrap items-center gap-3 border-b pb-4 last:border-b-0"
              >
                <div className="min-w-48">
                  <p className="font-medium">{device.name}</p>
                  <p className="text-muted-foreground text-sm">{device.lodgeName}</p>
                </div>
                <div className="flex items-center gap-2">
                  {device.revoked ? (
                    <Badge variant="destructive">Revoked</Badge>
                  ) : device.paired ? (
                    <Badge>Paired</Badge>
                  ) : (
                    <Badge variant="secondary">Unpaired</Badge>
                  )}
                  {device.pairingArmedUntil && !device.paired && (
                    <Badge variant="outline">Pairing armed</Badge>
                  )}
                  <span className="text-muted-foreground text-xs">
                    {device.lastSeenAt
                      ? `Last seen ${new Date(device.lastSeenAt).toLocaleString("en-NZ")}`
                      : "Never seen"}
                  </span>
                </div>
                {!device.revoked && (
                  <>
                    <div className="flex items-center gap-2">
                      <Input
                        className="w-32 uppercase"
                        placeholder="TV code"
                        maxLength={6}
                        value={codeByDevice[device.id] ?? ""}
                        onChange={(event) =>
                          setCodeByDevice((current) => ({
                            ...current,
                            [device.id]: event.target.value.toUpperCase(),
                          }))
                        }
                      />
                      <Button
                        variant="outline"
                        onClick={() => void armPairing(device.id)}
                        disabled={(codeByDevice[device.id] ?? "").length !== 6}
                      >
                        Pair
                      </Button>
                    </div>
                    <div className="flex items-center gap-2">
                      <Label className="text-xs" htmlFor={`template-${device.id}`}>
                        Template
                      </Label>
                      <select
                        id={`template-${device.id}`}
                        className="border-input bg-background h-9 rounded-md border px-3 text-sm"
                        value={device.templateKey ?? ""}
                        onChange={(event) =>
                          void assignTemplate(device.id, event.target.value)
                        }
                      >
                        <option value="">Club default</option>
                        {templates.map((template) => (
                          <option key={template.key} value={template.key}>
                            {template.name}
                            {template.source === "custom" ? " (custom)" : ""}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Button variant="outline" asChild>
                      <a
                        href={`/display?previewDevice=${device.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Preview
                      </a>
                    </Button>
                    <Button variant="destructive" onClick={() => void revoke(device.id)}>
                      Revoke
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
