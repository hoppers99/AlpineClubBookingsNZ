"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import type { ModuleSettingsValues } from "@/config/modules";

/**
 * Self-contained Login & Security card for Google sign-in (#2035).
 *
 * Mounted on the Login & Security page (`/admin/security`, #2033), which loads
 * the club module settings and whether the per-club Google credentials are
 * configured server-side.
 *
 * The enable/disable TOGGLE persists the `googleLogin` module column through the
 * existing `PUT /api/admin/modules` route (module toggles have no dedicated
 * per-key route — the whole settings object is written), mirroring the magic-link
 * card. When enabled without credentials, a readiness warning explains the button
 * will not appear until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
 */
export interface GoogleSecurityCardProps {
  moduleSettings: ModuleSettingsValues;
  credentialsConfigured: boolean;
}

export function GoogleSecurityCard({
  moduleSettings,
  credentialsConfigured,
}: GoogleSecurityCardProps) {
  const [enabled, setEnabled] = useState(moduleSettings.googleLogin);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedNote, setSavedNote] = useState("");

  async function persistEnabled(next: boolean) {
    setSaving(true);
    setError("");
    setSavedNote("");
    const previous = enabled;
    setEnabled(next);
    try {
      const res = await fetch("/api/admin/modules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: { ...moduleSettings, googleLogin: next },
        }),
      });
      if (!res.ok) {
        setEnabled(previous);
        setError("Could not update the Google sign-in setting.");
        return;
      }
      setSavedNote(next ? "Google sign-in enabled." : "Google sign-in disabled.");
    } catch {
      setEnabled(previous);
      setError("Could not update the Google sign-in setting.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Google sign-in</CardTitle>
        <CardDescription>
          Let members sign in with a Google account they have linked from their
          profile. This is additive to password login — it never replaces it — and
          no account is ever created from Google. Unlinked Google accounts are
          refused.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <Alert variant="error">{error}</Alert>}
        {savedNote && <Alert variant="success">{savedNote}</Alert>}

        {enabled && !credentialsConfigured && (
          <Alert variant="warning" title="Google credentials not configured">
            Google sign-in is enabled, but the sign-in button will not appear
            until <code>GOOGLE_CLIENT_ID</code> and{" "}
            <code>GOOGLE_CLIENT_SECRET</code> are configured server-side (your
            club&apos;s Google Cloud OAuth credentials).
          </Alert>
        )}

        <label className="flex items-start gap-3">
          <Checkbox
            checked={enabled}
            disabled={saving}
            onCheckedChange={persistEnabled}
            aria-label="Enable Google sign-in"
          />
          <span className="text-sm">
            <span className="font-medium">Enable Google sign-in</span>
            <span className="block text-muted-foreground">
              When on (and credentials are configured), the sign-in page shows a
              &ldquo;Continue with Google&rdquo; button, and members can link their
              Google account from their profile.
            </span>
          </span>
        </label>
      </CardContent>
    </Card>
  );
}
