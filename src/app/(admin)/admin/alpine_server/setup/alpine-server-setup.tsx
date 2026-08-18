"use client";

import { useState } from "react";
import { ArrowUpToLine, ArrowDownToLine, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { formatNZDateTime } from "@/lib/nzst-date";

interface InitialState {
  apiKeySet: boolean;
  apiKeyUpdatedAt: string | null;
  baseUrl: string | null;
  otherLodgesEnabled: boolean;
  otherLodgesLastUploadAt: string | null;
  otherLodgesLastDownloadAt: string | null;
}

function fmt(iso: string | null): string {
  if (!iso) return "never";
  return formatNZDateTime(new Date(iso));
}

export function AlpineServerSetup({ initialState }: { initialState: InitialState }) {
  const [baseUrl, setBaseUrl] = useState(initialState.baseUrl ?? "");
  const [savedBaseUrl, setSavedBaseUrl] = useState(initialState.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [apiKeySet, setApiKeySet] = useState(initialState.apiKeySet);
  const [enabled, setEnabled] = useState(initialState.otherLodgesEnabled);
  const [lastUpload, setLastUpload] = useState(initialState.otherLodgesLastUploadAt);
  const [lastDownload, setLastDownload] = useState(
    initialState.otherLodgesLastDownloadAt,
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const connectionReady = apiKeySet && savedBaseUrl.length > 0;

  async function saveBaseUrl() {
    setBusy("baseUrl");
    setMessage(null);
    try {
      const res = await fetch("/api/admin/alpine_server/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Failed to save base URL");
      setSavedBaseUrl(data.baseUrl ?? "");
      setBaseUrl(data.baseUrl ?? "");
      setMessage({ kind: "ok", text: "Base URL saved." });
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }

  async function saveApiKey() {
    if (!apiKey.trim()) return;
    setBusy("apiKey");
    setMessage(null);
    try {
      const res = await fetch("/api/admin/integrations/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "servernz",
          key: "api_key",
          value: apiKey.trim(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Failed to save API key");
      setApiKeySet(true);
      setApiKey("");
      setMessage({ kind: "ok", text: "API key stored securely." });
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }

  async function toggleEnabled() {
    setBusy("enable");
    setMessage(null);
    const next = !enabled;
    try {
      const res = await fetch("/api/admin/alpine_server/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otherLodgesEnabled: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "Failed to update");
      setEnabled(Boolean(data.otherLodgesEnabled));
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }

  async function syncOtherLodges(direction: "upload" | "download") {
    setBusy(direction);
    setMessage(null);
    try {
      const res = await fetch(
        `/api/admin/alpine_server/other-lodges/${direction}`,
        { method: "POST" },
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? `Failed to ${direction}`);
      if (direction === "upload") {
        setLastUpload(new Date().toISOString());
        setMessage({
          kind: "ok",
          text: `Uploaded ${data.sent ?? 0} changed: ${data.created} created, ${data.updated} updated, ${data.unchanged ?? 0} unchanged, ${data.skipped} skipped.`,
        });
      } else {
        setLastDownload(new Date().toISOString());
        setMessage({
          kind: "ok",
          text: `Downloaded ${data.fetched} entries: ${data.created} added, ${data.updated} updated, ${data.unchanged ?? 0} unchanged.`,
        });
      }
    } catch (e) {
      setMessage({ kind: "err", text: e instanceof Error ? e.message : "Failed" });
    } finally {
      setBusy(null);
    }
  }

  const requestConnectionHref = savedBaseUrl ? `${savedBaseUrl}/register` : null;

  return (
    <div className="space-y-6">
      {message ? (
        <p
          className={`text-sm ${message.kind === "ok" ? "text-success-11" : "text-destructive"}`}
          role="status"
        >
          {message.text}
        </p>
      ) : null}

      {/* Connection */}
      <Card>
        <CardHeader>
          <CardTitle>Connection</CardTitle>
          <CardDescription>
            Point this club at your Alpine Central Server and store the API key it
            issues you.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="acs-base-url">Server base URL</Label>
            <div className="flex gap-2">
              <Input
                id="acs-base-url"
                placeholder="https://central.alpineclub.nz"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <Button onClick={saveBaseUrl} disabled={busy !== null}>
                {busy === "baseUrl" ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>

          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <span>
                No account yet? Request a connection on the central server, then
                paste the API key below.
              </span>
              {requestConnectionHref ? (
                <a
                  href={requestConnectionHref}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 whitespace-nowrap font-medium underline underline-offset-4"
                >
                  Request a Connection
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </a>
              ) : (
                <span className="whitespace-nowrap text-xs text-muted-foreground">
                  Save a base URL first
                </span>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="acs-api-key">
              API key{" "}
              {apiKeySet ? (
                <Badge variant="secondary">stored</Badge>
              ) : (
                <Badge variant="outline">not set</Badge>
              )}
            </Label>
            <div className="flex gap-2">
              <Input
                id="acs-api-key"
                type="password"
                autoComplete="off"
                placeholder={apiKeySet ? "•••••••• (enter a new key to replace)" : "acs_…"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
              <Button
                onClick={saveApiKey}
                disabled={busy !== null || !apiKey.trim()}
              >
                {busy === "apiKey" ? "Saving…" : "Save key"}
              </Button>
            </div>
            {apiKeySet ? (
              <p className="text-xs text-muted-foreground">
                Last updated {fmt(initialState.apiKeyUpdatedAt)}. The key is stored
                encrypted and never shown again.
              </p>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Shared items */}
      <Card>
        <CardHeader>
          <CardTitle>Shared data</CardTitle>
          <CardDescription>
            Items synced between this club and the central server. Enable an item,
            then upload to push your data or download to pull the distributed set.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!connectionReady ? (
            <p className="mb-4 text-sm text-muted-foreground">
              Save a base URL and API key above to enable syncing.
            </p>
          ) : null}
          <div className="divide-y">
            {/* Only current shared item: Other Clubs details */}
            <div className="flex flex-col gap-3 py-4 first:pt-0 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">Other Clubs details</span>
                  <Badge variant={enabled ? "secondary" : "outline"}>
                    {enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  The registry of other clubs&apos; lodges (name, location, booking
                  officer, beds).
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Last upload {fmt(lastUpload)} · last download {fmt(lastDownload)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={toggleEnabled}
                  disabled={busy !== null}
                >
                  {enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  size="sm"
                  onClick={() => syncOtherLodges("upload")}
                  disabled={busy !== null || !enabled || !connectionReady}
                >
                  <ArrowUpToLine className="mr-1.5 h-4 w-4" />
                  {busy === "upload" ? "Uploading…" : "Upload"}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => syncOtherLodges("download")}
                  disabled={busy !== null || !enabled || !connectionReady}
                >
                  <ArrowDownToLine className="mr-1.5 h-4 w-4" />
                  {busy === "download" ? "Downloading…" : "Download"}
                </Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
