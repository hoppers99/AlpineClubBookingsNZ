"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ForbiddenSaveError,
  useSectionEditState,
} from "@/hooks/use-section-edit-state";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { PolicyFeedback } from "@/components/admin/booking-policies/policy-feedback";

/**
 * The member-guest policy card on Admin › Bookings setup ("+ Add Member
 * Guest", epic #2305, MG2 #2307; owner decisions D-3, D-17, D-18 and MG2-M-1/
 * MG2-M-4 as ticked, 30 Jul).
 *
 * MG2-M-1: this lives on the existing Bookings setup page beside the other
 * booking-policy configuration — deliberately NOT its own admin route, which
 * would cost the whole registry fan-out (sidebar, route-area matrix, feature
 * search, command palette) for one card.
 *
 * MG2-M-4: the card stays EDITABLE while the module is off, with a banner
 * saying nothing is in use, so a club can configure the policy first and then
 * switch the feature on. View-only is a real third state (the shared
 * banner + ViewOnlyActionButton pattern), never a Save that 403s.
 *
 * Follows the canonical settings-section pattern (`AGENTS.md`;
 * `group-discount-section.tsx` is the reference): loads read-only, Edit
 * reveals Save/Cancel, Cancel reverts to the saved snapshot, Save persists
 * once and re-seeds from the server response.
 *
 * The two name-search toggles carry the privacy warnings the owner accepted
 * verbatim on the mockup pack, and per D-18 neither value ever travels in club
 * config transfer — this card (backed by its admin route) is the only way they
 * change.
 */

interface MemberGuestSettingsDraft {
  approvalRequired: boolean;
  pendingHoldExpiryDays: number;
  openMemberSearchEnabled: boolean;
  openMemberSearchIncludesMinors: boolean;
  /**
   * Whether a row is actually persisted (#2142): the GET synthesises the
   * defaults when the club has never saved, and without this flag the pristine
   * dirty-gate would make the first save unreachable. Never sent to the server.
   */
  configured: boolean;
}

// Matches the shipped defaults (D-3: ask-first, 7 days, both searches off).
// Also the fallback a FAILED load leaves in the form; `configured: true` there
// so a pristine Save can never blind-write defaults over a real saved policy.
const MEMBER_GUEST_SETTINGS_SEED: MemberGuestSettingsDraft = {
  configured: true,
  approvalRequired: true,
  pendingHoldExpiryDays: 7,
  openMemberSearchEnabled: false,
  openMemberSearchIncludesMinors: false,
};

const ENDPOINT = "/api/admin/member-guest-settings";

const DEFAULT_BOUNDS = { min: 1, max: 60 };

type SettingsPayload = {
  settings: {
    approvalRequired: boolean;
    pendingHoldExpiryDays: number;
    openMemberSearchEnabled: boolean;
    openMemberSearchIncludesMinors: boolean;
  };
  updatedAt: string | null;
  bounds?: { pendingHoldExpiryDaysMin: number; pendingHoldExpiryDaysMax: number };
};

function toDraft(payload: SettingsPayload): MemberGuestSettingsDraft {
  return {
    approvalRequired: payload.settings.approvalRequired,
    pendingHoldExpiryDays: payload.settings.pendingHoldExpiryDays,
    openMemberSearchEnabled: payload.settings.openMemberSearchEnabled,
    openMemberSearchIncludesMinors: payload.settings.openMemberSearchIncludesMinors,
    // `updatedAt` is null exactly while the singleton row has never been saved.
    configured: payload.updatedAt !== null,
  };
}

export function MemberGuestSettingsCard({
  moduleEnabled,
}: {
  /** Whether the memberGuests module is on — drives the not-in-use banner. */
  moduleEnabled: boolean;
}) {
  // Same area the GET/PUT route enforces (bookings:view / bookings:edit).
  const canEdit = useAdminAreaEditAccess("bookings");
  // Echoed by the GET so the number input renders the server's own bounds
  // rather than a second client-side copy of the two constants.
  const [bounds, setBounds] = useState(DEFAULT_BOUNDS);

  const section = useSectionEditState<MemberGuestSettingsDraft>({
    initial: MEMBER_GUEST_SETTINGS_SEED,
    load: async (signal) => {
      const res = await fetch(ENDPOINT, { signal });
      if (!res.ok) throw new Error("Failed to load member-guest settings");
      const payload = (await res.json()) as SettingsPayload;
      if (payload.bounds) {
        setBounds({
          min: payload.bounds.pendingHoldExpiryDaysMin,
          max: payload.bounds.pendingHoldExpiryDaysMax,
        });
      }
      return toDraft(payload);
    },
    save: async (draft) => {
      const res = await fetch(ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalRequired: draft.approvalRequired,
          pendingHoldExpiryDays: draft.pendingHoldExpiryDays,
          openMemberSearchEnabled: draft.openMemberSearchEnabled,
          openMemberSearchIncludesMinors: draft.openMemberSearchIncludesMinors,
        }),
      });
      if (!res.ok) {
        if (res.status === 403) throw new ForbiddenSaveError();
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        throw new Error(
          typeof data.error === "string" ? data.error : "Failed to save",
        );
      }
      return toDraft((await res.json()) as SettingsPayload);
    },
    successMessage: "Member guest settings saved",
    // First save must be reachable on a never-saved club (#2142); after that,
    // an unchanged draft must not re-PUT — the route audits unconditionally,
    // and a no-op save would still record a privacy-posture re-affirmation the
    // admin never meant to make.
    isDirty: (draft, saved) =>
      !draft.configured ||
      draft.approvalRequired !== saved.approvalRequired ||
      draft.pendingHoldExpiryDays !== saved.pendingHoldExpiryDays ||
      draft.openMemberSearchEnabled !== saved.openMemberSearchEnabled ||
      draft.openMemberSearchIncludesMinors !== saved.openMemberSearchIncludesMinors,
  });

  const { draft, editing, saving, dirty, error, success } = section;

  // The view-only explanation, once, at the top of the section — rendered in
  // every state so the live region exists from first paint (see
  // group-discount-section.tsx for the screen-reader reasoning).
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      You can see these settings but not change them. Ask an administrator with
      booking-settings access if something here needs changing.
    </AdminViewOnlySectionBanner>
  );

  const feedback = (
    <PolicyFeedback
      error={error}
      success={success}
      onClearError={() => section.setError("")}
      onClearSuccess={() => section.setSuccess("")}
    />
  );

  if (section.loading || !draft) {
    return (
      <div>
        {viewOnlyBanner}
        {feedback}
        {section.loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Loading...
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      {viewOnlyBanner}
      {feedback}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle>Member guests</CardTitle>
            <CardDescription>
              Lets a member add another club member — outside their own family
              group — as a guest on their booking.
            </CardDescription>
          </div>
          {!editing && (
            <ViewOnlyActionButton
              canEdit={canEdit}
              describeReason={false}
              variant="outline"
              size="sm"
              onClick={section.startEditing}
            >
              Edit
            </ViewOnlyActionButton>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          {!moduleEnabled ? (
            // MG2-M-4 as ticked: editable while the module is off, with this
            // banner — settings are saved but inert until the module is on.
            <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              Member guests is switched off, so none of this is in use. You can
              still set it up here; turn the module on under{" "}
              <Link
                href="/admin/modules"
                className="font-medium text-foreground underline"
              >
                Admin › Modules
              </Link>{" "}
              when you are ready.
            </div>
          ) : null}

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Does the other member have to agree first?
            </legend>
            <label className="flex items-start gap-3 rounded-md border border-border bg-muted/50 px-3 py-2">
              <input
                type="radio"
                name="member-guest-approval"
                checked={draft.approvalRequired}
                onChange={() => section.setDraft({ approvalRequired: true })}
                disabled={!editing}
                className="mt-1"
              />
              <span className="text-sm">
                <span className="block font-medium">Ask them first</span>
                <span className="text-muted-foreground">
                  The member is emailed and the bed is held until they answer.
                  Recommended, and the default.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-3 rounded-md border border-border bg-muted/50 px-3 py-2">
              <input
                type="radio"
                name="member-guest-approval"
                checked={!draft.approvalRequired}
                onChange={() => section.setDraft({ approvalRequired: false })}
                disabled={!editing}
                className="mt-1"
              />
              <span className="text-sm">
                <span className="block font-medium">Just tell them</span>
                <span className="text-muted-foreground">
                  The guest is added straight away and the member is emailed to
                  say so. They can still take themselves off.
                </span>
              </span>
            </label>
          </fieldset>

          <div className="space-y-2 max-w-xs">
            <Label htmlFor="member-guest-expiry-days">
              How long to wait for an answer
            </Label>
            <Input
              id="member-guest-expiry-days"
              type="number"
              min={bounds.min}
              max={bounds.max}
              value={draft.pendingHoldExpiryDays}
              onChange={(e) => {
                const value = parseInt(e.target.value, 10);
                section.setDraft({
                  pendingHoldExpiryDays: Number.isNaN(value) ? 0 : value,
                });
              }}
              className={`w-24 ${!editing ? "bg-muted text-muted-foreground" : ""}`}
              disabled={!editing}
            />
            <p className="text-xs text-muted-foreground">
              Days, {bounds.min} to {bounds.max}. After this the request lapses
              on its own, the bed is released, and the person who made the
              booking is told. A request never outlives the stay: it always
              lapses at least a day before check-in.
            </p>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">
              Finding the other member
            </legend>
            <label className="flex items-start gap-3 rounded-md border border-border bg-muted/50 px-3 py-2">
              <input
                type="checkbox"
                checked={draft.openMemberSearchEnabled}
                onChange={(e) =>
                  section.setDraft({ openMemberSearchEnabled: e.target.checked })
                }
                disabled={!editing}
                className="mt-1 rounded border-input"
              />
              <span className="text-sm">
                <span className="block font-medium">
                  Let members search by name
                </span>
                <span className="text-muted-foreground">
                  Off: a member must type the other member&apos;s exact email
                  address. On: they can type a name and pick from a list.
                </span>
              </span>
            </label>
            <p className="rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
              Turning this on makes your membership list browsable. Any member
              can type a few letters and see the names of other members who
              match. Leave it off unless your club has agreed to that.
            </p>
            <label className="ml-6 flex items-start gap-3 rounded-md border border-border bg-muted/50 px-3 py-2">
              <input
                type="checkbox"
                checked={draft.openMemberSearchIncludesMinors}
                onChange={(e) =>
                  section.setDraft({
                    openMemberSearchIncludesMinors: e.target.checked,
                  })
                }
                disabled={!editing}
                className="mt-1 rounded border-input"
              />
              <span className="text-sm">
                <span className="block font-medium">
                  Include under-18s in name search
                </span>
                <span className="text-muted-foreground">
                  Off: children never appear in the name list.
                </span>
              </span>
            </label>
            <p className="ml-6 rounded-md border border-warning-6 bg-warning-3 px-3 py-2 text-sm text-warning-11">
              Turning this on makes children&apos;s names browsable to any
              member. A child can still be added by their household email
              address either way.
            </p>
          </fieldset>

          <div className="rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">
              These two search settings never travel in club config transfer
            </span>{" "}
            (owner decision D-18). Importing another club&apos;s configuration
            must not quietly make your membership list browsable. The module
            switch, the ask-first choice and the waiting period do travel.
          </div>

          {editing && (
            <div className="flex gap-3">
              <ViewOnlyActionButton
                canEdit={canEdit}
                describeReason={false}
                onClick={() => void section.save()}
                disabled={!dirty || saving}
              >
                {saving ? "Saving..." : "Save"}
              </ViewOnlyActionButton>
              <Button
                variant="outline"
                onClick={section.cancelEditing}
                disabled={saving}
              >
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
