"use client";

import type { AgeTier } from "@prisma/client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { AdminDataTable } from "@/components/admin/admin-data-table";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import { emitSetupReadinessInputChanged } from "@/lib/setup-readiness-events";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirm } from "@/components/confirm-dialog";

type AgeTierRow = {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  subscriptionRequiredForBooking: boolean;
  familyGroupRequestCreateMemberAllowed: boolean;
  sortOrder: number;
};

const DEFAULT_SETTINGS: AgeTierRow[] = [
  {
    tier: "INFANT",
    minAge: 0,
    maxAge: 4,
    label: "Infant (under 5)",
    subscriptionRequiredForBooking: false,
    familyGroupRequestCreateMemberAllowed: true,
    sortOrder: 0,
  },
  {
    tier: "CHILD",
    minAge: 5,
    maxAge: 9,
    label: "Child (5-9)",
    subscriptionRequiredForBooking: false,
    familyGroupRequestCreateMemberAllowed: true,
    sortOrder: 1,
  },
  {
    tier: "YOUTH",
    minAge: 10,
    maxAge: 17,
    label: "Youth (10-17)",
    subscriptionRequiredForBooking: true,
    familyGroupRequestCreateMemberAllowed: false,
    sortOrder: 2,
  },
  {
    tier: "ADULT",
    minAge: 18,
    maxAge: null,
    label: "Adult (18+)",
    subscriptionRequiredForBooking: true,
    familyGroupRequestCreateMemberAllowed: false,
    sortOrder: 3,
  },
];

function normalizeAgeTierRows(rows: AgeTierRow[]): AgeTierRow[] {
  return rows.map((row) => ({
    ...row,
    subscriptionRequiredForBooking: row.subscriptionRequiredForBooking ?? true,
    familyGroupRequestCreateMemberAllowed:
      row.familyGroupRequestCreateMemberAllowed ?? false,
  }));
}

/**
 * The age-tier boundary editor, as an EMBEDDABLE SECTION (epic #213, child
 * C18, #249).
 *
 * ## Why this is a section and not a page any more
 *
 * `/admin/age-tier-settings/page.tsx` was the whole editor — it fetched for
 * itself, resolved `bookings` edit access for itself and headed itself with
 * its own view-only banner. That is the same page-is-component shape C13
 * (#239) lifted `ModulesSection` out of, so this repeats that move rather
 * than inventing a new one: the page keeps the screen's `AdminPageHeader`,
 * and this section owns everything with state, the same split
 * `/admin/modules` and `ModulesSection` settled on.
 *
 * **SIMPLER than C13.** The module toggles could remove the very step the
 * operator was standing on (switching `addressAutocomplete` off from inside
 * the `address-autocomplete` step), which needed a fallback and a notice in
 * the wizard shell. An age tier cannot do that — no setup step is keyed to a
 * particular tier existing, so there is no self-removal case for this pane
 * to handle.
 *
 * ## Zero props, and NO HEADING OF ITS OWN
 *
 * Both hosts supply the heading: `/admin/age-tier-settings` keeps its
 * `AdminPageHeader`, and the wizard's `age-tiers` step already has its own
 * subordinate heading below the wizard's `h1`. Handing this section a
 * heading of its own would leave the wizard drawing two.
 *
 * ## The view-only banner stays HERE
 *
 * `describeReason={false}` on the Edit button below is a STATIC opt-out
 * (`view-only-banner-contract.test.ts`), which requires the banner it
 * explains to live in the SAME file — so the two move together or not at
 * all, exactly as `ModulesSection` documents for its own Save.
 *
 * ## Saving announces itself
 *
 * The age-tier readiness check (`buildAgeTierCheck` in
 * `setup-readiness.ts`) reads the saved boundaries directly, so a save here
 * can flip the `age-tiers` step's own badge — hence
 * `emitSetupReadinessInputChanged()` after a successful save, the same
 * announcement `ClubIdentityPanel` and `ModulesSection` make. When this
 * section is mounted inside the wizard the operator never leaves the tab, so
 * neither of the shell's focus/visibility refetches can fire on its own.
 *
 * **That announcement cannot make the check go green by itself.** Half of
 * `buildAgeTierCheck` reads facts this section never touches: it also flags
 * any membership type set to "subscription required based on age tier"
 * while no tier actually requires one
 * (`basedOnAgeTierTypesWithoutSubscribingTier`, `setup-readiness.ts`
 * ~1642-1648), and that flag is fixed on `/admin/membership-types`, not
 * here. A perfectly-saved set of tiers can therefore still leave the step
 * amber — `AgeTierWizardPane` in `setup-wizard-panes.tsx` says so in its own
 * orientation copy, the way `ModulesWizardPane` names the address-autocomplete
 * split rather than leaving the operator to discover it.
 */
export function AgeTierSection() {
  // Age-tier boundaries are a bookings-area setting; a bookings:view admin sees
  // the panel read-only (#1940). The PUT route enforces bookings:edit.
  const canEdit = useAdminAreaEditAccess("bookings");
  const { confirm, confirmDialog } = useConfirm();
  const [settings, setSettings] = useState<AgeTierRow[]>([]);
  const [savedSettings, setSavedSettings] = useState<AgeTierRow[]>([]);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/age-tier-settings")
      .then((r) => r.json())
      .then((d) => {
        const rows = d.settings ?? [];
        const data = normalizeAgeTierRows(rows.length > 0 ? rows : DEFAULT_SETTINGS);
        setSettings(data);
        setSavedSettings(data);
      })
      .catch(() => setError("Failed to load settings"))
      .finally(() => setLoading(false));
  }, []);

  const sorted = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
  const lastTier = sorted[sorted.length - 1];

  function updateRow(
    tier: string,
    field: keyof AgeTierRow,
    value: string | number | boolean | null
  ) {
    setSettings((prev) =>
      prev.map((setting) =>
        setting.tier === tier ? { ...setting, [field]: value } : setting
      )
    );
    setSuccess(false);
    setError(null);
  }

  // Remove a tier (issue #2009 — a club may run a SUBSET of the four built-in
  // tiers). ADULT is the unbounded terminal tier and can never be removed. After
  // dropping a tier the boundaries re-tile automatically on save (each tier's
  // maxAge is derived from the next tier's minAge), and we coerce the youngest
  // remaining tier to start at age 0 so the saved set still covers 0 → ∞. The PUT
  // route makes the final call: if a live member or upcoming booking guest is
  // still classified into the removed tier it fails closed with a clear message.
  function handleRemoveTier(tier: string) {
    if (tier === "ADULT") return;
    setSettings((prev) => {
      const remaining = prev
        .filter((setting) => setting.tier !== tier)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((setting, index) => ({ ...setting, sortOrder: index }));
      if (remaining.length > 0) {
        remaining[0] = { ...remaining[0], minAge: 0 };
      }
      return remaining;
    });
    setSuccess(false);
    setError(null);
  }

  async function handleRestoreDefaults() {
    // Restoring overwrites the custom boundaries/labels in the editor with the
    // four built-in tiers. It does not save on its own — the admin must still
    // press Save Changes — but confirm first so a click never silently discards
    // in-progress edits.
    const confirmed = await confirm({
      title: "Restore default age tiers?",
      description:
        "This replaces the tiers in the editor with the four built-in defaults (INFANT, CHILD, YOUTH, ADULT), discarding your custom boundaries and labels. Nothing is saved until you press Save Changes.",
      confirmLabel: "Restore defaults",
    });
    if (!confirmed) return;
    setSettings(normalizeAgeTierRows(DEFAULT_SETTINGS));
    setSuccess(false);
    setError(null);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    setSuccess(false);

    const bySort = [...settings].sort((a, b) => a.sortOrder - b.sortOrder);
    const payload = bySort.map((setting, index) => {
      const next = bySort[index + 1];
      return {
        ...setting,
        maxAge: next ? next.minAge - 1 : null,
      };
    });

    try {
      const res = await fetch("/api/admin/age-tier-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: payload }),
      });
      if (res.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save");
      } else {
        setSettings(data.settings);
        setSavedSettings(data.settings);
        setEditing(false);
        setSuccess(true);
        // The age-tier readiness check reads these boundaries directly
        // (`buildAgeTierCheck`), so a successful save can flip its badge.
        // Announced only after the write succeeded — see this component's
        // docblock for why an optimistic emit would be wrong.
        emitSetupReadinessInputChanged();
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setSettings(savedSettings);
    setEditing(false);
    setError(null);
    setSuccess(false);
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-*` stack so
    the empty wrapper an edit-capable admin gets costs no layout.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Your admin role can view the age tier settings but cannot change
      them. Bookings edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Age Tier Boundaries</CardTitle>
          {!editing && (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(true);
                setSuccess(false);
              }}
            >
              Edit
            </ViewOnlyActionButton>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading settings...</p>
          ) : null}

          {sorted.map((setting) => {
            const isLastTier = lastTier && setting.tier === lastTier.tier;
            const maxAgeDisplay = isLastTier
              ? "No limit"
              : String(
                  (sorted.find((row) => row.sortOrder === setting.sortOrder + 1)
                    ?.minAge ?? 0) - 1
                );
            const labelInputId = `age-tier-label-${setting.tier}`;
            const minAgeInputId = `age-tier-min-age-${setting.tier}`;
            const maxAgeInputId = `age-tier-max-age-${setting.tier}`;
            const subscriptionInputId = `subscription-required-${setting.tier}`;
            const familyRequestCreateInputId =
              `family-request-create-member-${setting.tier}`;

            return (
              <div
                key={setting.tier}
                className="space-y-4 border-b pb-5 last:border-0 last:pb-0"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {setting.tier}
                    </p>
                    <p className="text-sm text-muted-foreground">{setting.label}</p>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="text-xs text-muted-foreground">
                      Ages {setting.minAge}
                      {isLastTier ? "+" : `-${maxAgeDisplay}`}
                    </p>
                    {editing && setting.tier !== "ADULT" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => handleRemoveTier(setting.tier)}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-[minmax(12rem,1.25fr)_minmax(7rem,0.55fr)_minmax(7rem,0.55fr)_minmax(15rem,1.65fr)]">
                  <div className="space-y-1">
                    <Label htmlFor={labelInputId}>Label</Label>
                    <Input
                      id={labelInputId}
                      value={setting.label}
                      onChange={(event) =>
                        updateRow(setting.tier, "label", event.target.value)
                      }
                      disabled={!editing}
                      className={!editing ? "bg-muted text-foreground" : ""}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={minAgeInputId}>Min Age (years)</Label>
                    <Input
                      id={minAgeInputId}
                      type="number"
                      min={0}
                      value={setting.minAge}
                      onChange={(event) =>
                        updateRow(
                          setting.tier,
                          "minAge",
                          parseInt(event.target.value, 10)
                        )
                      }
                      disabled={!editing}
                      className={!editing ? "bg-muted text-foreground" : ""}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={maxAgeInputId}>Max Age (years)</Label>
                    <Input
                      id={maxAgeInputId}
                      type="text"
                      disabled
                      value={maxAgeDisplay}
                      className="bg-muted text-muted-foreground"
                    />
                    {!isLastTier ? (
                      <p className="text-xs text-muted-foreground">From next min age</p>
                    ) : null}
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  <div className="flex items-start gap-3 rounded-md border bg-muted p-3">
                    <Checkbox
                      id={subscriptionInputId}
                      checked={setting.subscriptionRequiredForBooking}
                      onCheckedChange={(checked) =>
                        updateRow(
                          setting.tier,
                          "subscriptionRequiredForBooking",
                          checked === true
                        )
                      }
                      disabled={!editing}
                    />
                    <div className="space-y-1">
                      <Label htmlFor={subscriptionInputId}>
                        Subscription Required for Booking
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Requires a paid subscription before members in this tier can be
                        booked as owners or member guests.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-3 rounded-md border bg-muted p-3">
                    <Checkbox
                      id={familyRequestCreateInputId}
                      checked={setting.familyGroupRequestCreateMemberAllowed}
                      onCheckedChange={(checked) =>
                        updateRow(
                          setting.tier,
                          "familyGroupRequestCreateMemberAllowed",
                          checked === true
                        )
                      }
                      disabled={!editing}
                    />
                    <div className="space-y-1">
                      <Label htmlFor={familyRequestCreateInputId}>
                        Allow admin-created members from family group requests
                      </Label>
                      <p className="text-xs text-muted-foreground">
                        Lets admins approve a pending family request by creating a
                        non-login dependant when the request DOB maps to this tier.
                      </p>
                    </div>
                  </div>

                </div>
              </div>
            );
          })}

          {error ? (
            <div className="rounded-md border border-danger/20 bg-danger-muted p-3 text-sm text-danger">
              {error}
            </div>
          ) : null}
          {success ? (
            <div className="rounded-md border border-success/20 bg-success-muted p-3 text-sm text-success">
              Age tier settings saved successfully.
            </div>
          ) : null}

          {editing ? (
            <div className="flex flex-wrap gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : "Save Changes"}
              </Button>
              <Button variant="outline" onClick={handleCancel} disabled={saving}>
                Cancel
              </Button>
              {settings.length < DEFAULT_SETTINGS.length ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleRestoreDefaults}
                  disabled={saving}
                >
                  Restore default tiers
                </Button>
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Current Boundaries</CardTitle>
        </CardHeader>
        <CardContent>
          <AdminDataTable>
            <TableHeader>
              <TableRow>
                <TableHead>Tier</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Age Range</TableHead>
                <TableHead>Booking Subscription</TableHead>
                <TableHead>Family Request Creation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((setting) => (
                <TableRow key={setting.tier}>
                  <TableCell className="font-medium">{setting.tier}</TableCell>
                  <TableCell>{setting.label}</TableCell>
                  <TableCell>
                    {setting.maxAge !== null
                      ? `${setting.minAge} – ${setting.maxAge}`
                      : `${setting.minAge}+`}
                  </TableCell>
                  <TableCell>
                    {setting.subscriptionRequiredForBooking ? "Required" : "Not required"}
                  </TableCell>
                  <TableCell>
                    {setting.familyGroupRequestCreateMemberAllowed
                      ? "Allowed"
                      : "Link existing only"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </AdminDataTable>
        </CardContent>
      </Card>

      {confirmDialog}
      </div>
    </div>
  );
}
