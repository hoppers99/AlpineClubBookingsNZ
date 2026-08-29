"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, Pencil, Plus, Settings2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { useAdminAreaEditAccess } from "@/hooks/use-admin-area-edit-access";
import {
  ADMIN_FORBIDDEN_SAVE_REASON,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import { emitSetupReadinessInputChanged } from "@/lib/setup-readiness-events";
import { OtherLodgesPanel } from "./_components/other-lodges-panel";

/**
 * The lodge list, its rename/add form and its activation controls, as an
 * EMBEDDABLE SECTION (epic #213, child C19, #250; owner decision D18; UAT R2-7).
 *
 * ## Why this is a section and not a page any more
 *
 * It was the whole of `/admin/lodges/page.tsx` — a page-is-component that
 * fetched for itself, resolved `lodge` edit access for itself and headed itself
 * with its own view-only banner. That is already the shape the wizard's pane
 * registry mounts, so the only thing between the lodge list and the wizard was
 * the file it lived in. R2-7 is the reason it moved: an operator standing on
 * the wizard's Lodges step asked "and how do I set up a lodge here???" of a
 * screen that offered two links out and no inline anything. C13 (#239) did this
 * to `/admin/modules` first and this follows it exactly — the page is now a
 * shell around this section.
 *
 * ## What rides, and what deliberately does not
 *
 * Everything the page had: the list with each lodge's open/closed state, the
 * rename form, add-a-lodge, the activate/deactivate control including its
 * dependency force-confirm retry, and `OtherLodgesPanel`.
 *
 * **The per-lodge six-step flow stays a LINK, on purpose.** `/admin/lodges/[id]/setup`
 * is a whole guided flow — rooms, lockers, seasons, chores, then activation —
 * and embedding it would be embedding a wizard inside a wizard rather than
 * embedding a section. It is also the product's best setup screen already, so
 * D18's judgement was to send the operator to it rather than to reproduce it.
 * Each row's "Configure" button and the step frame's own per-lodge links both
 * still point there.
 *
 * ## Zero props, and NO HEADING OF ITS OWN
 *
 * Both hosts supply the heading, because the two need different ones: the page
 * needs the screen's `h1`, and the wizard — which already spends its `h1` on
 * "Setup wizard" — needs a subordinate one inside its pane. That is
 * `ModulesSection`'s arrangement, and `ClubIdentityPanel`'s before it. "Add
 * lodge" therefore comes with the section rather than sitting beside a heading
 * it no longer owns, so on `/admin/lodges` that button now opens the section
 * instead of sharing the title's row. Same control, same states, one row lower.
 *
 * ## The view-only banner stays HERE, and it is load-bearing twice over
 *
 * `describeReason={false}` on the five gated controls below is a STATIC opt-out
 * (`view-only-banner-contract.test.ts`), which requires a banner in the SAME
 * file — so the banner and the controls it explains move together or not at all.
 *
 * The second reason is the one that would have been easy to miss:
 * `<OtherLodgesPanel ancestorRendersViewOnlyBanner />` is a VOUCH (#2168). That
 * panel renders no banner of its own and its controls opt out of the per-button
 * reason, on the strength of a promise made at this render site that an
 * ancestor renders one above it. The contract test verifies that promise by
 * AST against the file the render site is in. Had the banner stayed on the page
 * and only the panel moved here, the wizard would have mounted an unbannered
 * panel whose controls explain nothing to a view-only admin — the vouch would
 * be a lie in one of its two hosts. Banner and vouched child move together.
 *
 * ## Saving announces itself
 *
 * A lodge's existence and its active flag are readiness INPUTS: `buildLodgesCheck`
 * (`setup-readiness.ts`) reads both, and its per-lodge links are derived from
 * the list. When this section is mounted INSIDE the wizard the operator never
 * leaves the tab, so neither of the shell's focus/visibility refetches can
 * fire — hence `emitSetupReadinessInputChanged()` after a successful create,
 * rename or activation, the same announcement `ModulesSection` and
 * `ClubIdentityPanel` make. It names no wizard, and on `/admin/lodges` — where
 * nothing is listening — it costs one no-op dispatch.
 */

/**
 * The three lodge DETAIL fields, which `GET /api/admin/lodges` omits for a
 * caller holding no `lodge:view` (#2925).
 */
const LODGE_DETAIL_FIELDS = ["address", "doorCode", "travelNote"] as const;
type LodgeDetailField = (typeof LODGE_DETAIL_FIELDS)[number];

type LodgeRecord = {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  // Optional since #2925: a narrowed payload carries none of the three.
  address?: string | null;
  doorCode?: string | null;
  travelNote?: string | null;
};

type LodgeFormState = {
  name: string;
  address: string;
  doorCode: string;
  travelNote: string;
  /**
   * Which detail fields the record this form was seeded from actually carried
   * (#2925). A field missing here is OMITTED from the PATCH body rather than
   * sent as an empty string, because the PATCH route treats an absent key as
   * "leave unchanged" and a `null` as "clear it" — so seeding a form from a
   * narrowed record and saving it would otherwise WIPE the door code.
   *
   * BELT-AND-BRACES, and worth knowing which: the wipe is already impossible at
   * the server. The PATCH needs `lodge:edit`, the list narrows below
   * `lodge:view`, and `edit` outranks `view` in `LEVEL_RANK` — so any caller who
   * can write here was served the full record. This is kept because it is a few
   * lines and directly tested; it is deliberately not replicated in the lodge
   * setup wizard, where a second copy bought no reachable safety and made the
   * page reject any lodge fixture that omitted `doorCode`.
   * Cross-tab staleness is a stated limit, not solved here: a second admin's
 * change in another tab shows only after this section's next mount — the
 * partial-field PATCH keeps the clobber risk low (unlike ModulesSection's
 * full-record PUT, which is why that section grew a focus refetch and this
 * one has not).
 */
  detailFields: readonly LodgeDetailField[];
};

const emptyForm: LodgeFormState = {
  name: "",
  address: "",
  doorCode: "",
  travelNote: "",
  // A create starts from a blank form the admin filled in themselves, so all
  // three values are theirs to send.
  detailFields: LODGE_DETAIL_FIELDS,
};

function formFromLodge(lodge: LodgeRecord): LodgeFormState {
  return {
    name: lodge.name,
    address: lodge.address ?? "",
    doorCode: lodge.doorCode ?? "",
    travelNote: lodge.travelNote ?? "",
    detailFields: LODGE_DETAIL_FIELDS.filter((field) => field in lodge),
  };
}

function formPayload(form: LodgeFormState) {
  const payload: {
    name: string;
    address?: string | null;
    doorCode?: string | null;
    travelNote?: string | null;
  } = { name: form.name.trim() };
  for (const field of form.detailFields) {
    payload[field] = form[field].trim() || null;
  }
  return payload;
}

export function LodgesSection() {
  const router = useRouter();
  // Lodge properties are lodge config; the write routes enforce lodge:edit, so
  // a lodge:view admin sees this screen read-only (#1940).
  const canEdit = useAdminAreaEditAccess("lodge");
  const [lodges, setLodges] = useState<LodgeRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<LodgeFormState>(emptyForm);

  const loadLodges = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/lodges");
      if (!response.ok) {
        throw new Error("Failed to load lodges");
      }
      const data = (await response.json()) as { lodges: LodgeRecord[] };
      setLodges(data.lodges);
    } catch {
      setError("Could not load lodges. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadLodges();
  }, [loadLodges]);

  function startCreate() {
    setCreating(true);
    setEditingId(null);
    setForm(emptyForm);
  }

  function startEdit(lodge: LodgeRecord) {
    setEditingId(lodge.id);
    setCreating(false);
    setForm(formFromLodge(lodge));
  }

  function cancelEdit() {
    setEditingId(null);
    setCreating(false);
    setForm(emptyForm);
  }

  async function submitForm() {
    if (!form.name.trim()) {
      setError("Lodge name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = creating
        ? await fetch("/api/admin/lodges", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(formPayload(form)),
          })
        : await fetch(`/api/admin/lodges/${editingId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(formPayload(form)),
          });
      if (response.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(data?.error ?? "Failed to save lodge");
      }
      if (creating) {
        // A new lodge lands straight in the guided setup wizard; identity is
        // pre-filled there and every remaining step can be skipped.
        const data = (await response.json()) as { lodge: LodgeRecord };
        // Announced BEFORE the navigation, because a lodge that now exists is
        // a fact the lodges check reads whether or not this component survives
        // the route change. Mounted in the setup wizard the operator leaves it
        // for the per-lodge flow; mounted on `/admin/lodges` nothing is
        // listening and it is a no-op either way.
        emitSetupReadinessInputChanged();
        router.push(`/admin/lodges/${encodeURIComponent(data.lodge.id)}/setup`);
        return;
      }
      cancelEdit();
      // A rename changes the name every per-lodge readiness line and link is
      // labelled with, so the wizard re-reads rather than keeping the old one.
      emitSetupReadinessInputChanged();
      await loadLodges();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save lodge");
    } finally {
      setSaving(false);
    }
  }

  async function setActive(lodge: LodgeRecord, active: boolean, force = false) {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/admin/lodges/${lodge.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(force ? { active, force: true } : { active }),
      });
      if (response.status === 403) {
        setError(ADMIN_FORBIDDEN_SAVE_REASON);
        return;
      }
      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as {
          error?: string;
          code?: string;
          dependencies?: {
            futureBookings: number;
            waitlistEntries: number;
            hutLeaderAssignments: number;
            kioskBindings: number;
          };
        } | null;
        // Deactivation pre-flight: the lodge still has dependencies. Show what
        // they are and let the admin confirm; a confirmed retry sends force.
        if (
          !force &&
          data?.code === "LODGE_HAS_DEPENDENCIES" &&
          data.dependencies
        ) {
          const d = data.dependencies;
          const parts = [
            d.futureBookings ? `${d.futureBookings} future booking(s)` : null,
            d.waitlistEntries ? `${d.waitlistEntries} waitlist entry(ies)` : null,
            d.hutLeaderAssignments
              ? `${d.hutLeaderAssignments} hut-leader assignment(s)`
              : null,
            d.kioskBindings ? `${d.kioskBindings} bound kiosk account(s)` : null,
          ].filter(Boolean);
          const proceed = window.confirm(
            `${lodge.name} still has ${parts.join(", ")}. Deactivating stops new bookings but leaves these in place. Deactivate anyway?`,
          );
          if (proceed) {
            await setActive(lodge, active, true);
          }
          return;
        }
        throw new Error(data?.error ?? "Failed to update lodge");
      }
      // Whether a lodge is open for booking IS the lodges check's verdict, so
      // this is the announcement that matters most: the badge, the step's
      // detail lines and its per-lodge link labels all move on it. Emitted only
      // after the write succeeded — and, on the force path, only by the retry
      // that actually wrote, since the refused first attempt returns above.
      emitSetupReadinessInputChanged();
      await loadLodges();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update lodge");
    } finally {
      setSaving(false);
    }
  }

  const showForm = creating || editingId !== null;

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
      Your admin role can view the lodge properties but cannot change them.
      Lodge edit access is required.
    </AdminViewOnlySectionBanner>
  );

  return (
    <div>
      {viewOnlyBanner}
      <div className="space-y-6">
      <div className="flex flex-wrap justify-end gap-2">
        <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={startCreate} disabled={saving || showForm || loading || error !== null}>
          <Plus className="mr-2 h-4 w-4" />
          Add lodge
        </ViewOnlyActionButton>
      </div>

      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}

      {showForm ? (
        <Card>
          <CardHeader>
            <CardTitle>{creating ? "Add lodge" : "Edit lodge"}</CardTitle>
            <CardDescription>
              The address feeds the public {"{{lodge-address}}"} content token.
              The door code and travel note appear in booking and pre-arrival
              emails for this lodge.
            </CardDescription>
            {creating ? (
              /*
                #221: a new lodge is created INACTIVE, so say so before the
                operator presses the button rather than leaving them to notice
                the badge afterwards. Saving drops straight into the guided
                setup, whose last step is where activation happens.
              */
              <p
                className="mt-2 text-sm text-muted-foreground"
                data-testid="lodge-create-inactive-hint"
              >
                A new lodge is not open for booking until you activate it.
                Saving takes you into its guided setup, and the last step is
                where you turn it on — so nothing half-configured can reach a
                member in the meantime.
              </p>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="lodge-name">Name</Label>
              <Input
                id="lodge-name"
                value={form.name}
                maxLength={120}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, name: event.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lodge-address">Address</Label>
              <Textarea
                id="lodge-address"
                value={form.address}
                maxLength={300}
                rows={2}
                placeholder="Optional — feeds the public {{lodge-address}} token"
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, address: event.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lodge-door-code">Door code</Label>
              <Input
                id="lodge-door-code"
                value={form.doorCode}
                maxLength={80}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, doorCode: event.target.value }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lodge-travel-note">Travel note</Label>
              <Textarea
                id="lodge-travel-note"
                value={form.travelNote}
                maxLength={2000}
                rows={3}
                onChange={(event) =>
                  setForm((prev) => ({
                    ...prev,
                    travelNote: event.target.value,
                  }))
                }
              />
            </div>
            <div className="flex gap-2">
              <ViewOnlyActionButton canEdit={canEdit} describeReason={false} onClick={() => void submitForm()} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </ViewOnlyActionButton>
              <Button variant="outline" onClick={cancelEdit} disabled={saving}>
                <X className="mr-2 h-4 w-4" />
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Lodge properties
          </CardTitle>
          <CardDescription>
            At least one lodge must stay active. Deactivated lodges are kept
            for history but cannot take new bookings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading lodges...</p>
          ) : error ? null : lodges.length === 0 ? (
            <p className="text-sm text-muted-foreground">No lodges found.</p>
          ) : (
            <ul className="divide-y">
              {lodges.map((lodge) => (
                <li
                  key={lodge.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{lodge.name}</span>
                      <Badge variant={lodge.active ? "default" : "secondary"}>
                        {lodge.active ? "Active" : "Inactive"}
                      </Badge>
                    </div>
                    {lodge.travelNote ? (
                      <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                        {lodge.travelNote}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/admin/lodges/${lodge.id}`}>
                        <Settings2 className="mr-2 h-4 w-4" />
                        Configure
                      </Link>
                    </Button>
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      variant="outline"
                      size="sm"
                      onClick={() => startEdit(lodge)}
                      disabled={saving}
                    >
                      <Pencil className="mr-2 h-4 w-4" />
                      Edit
                    </ViewOnlyActionButton>
                    <ViewOnlyActionButton
                      canEdit={canEdit}
                      describeReason={false}
                      variant="outline"
                      size="sm"
                      onClick={() => void setActive(lodge, !lodge.active)}
                      disabled={saving}
                    >
                      {lodge.active ? "Deactivate" : "Activate"}
                    </ViewOnlyActionButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <OtherLodgesPanel ancestorRendersViewOnlyBanner />
      </div>
    </div>
  );
}
