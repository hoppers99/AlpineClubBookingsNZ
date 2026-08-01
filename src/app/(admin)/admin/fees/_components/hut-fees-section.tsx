"use client";

import type { AgeTier } from "@prisma/client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldHint, describedByFieldHint, useFieldHint } from "@/components/ui/field-hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { APP_CURRENCY } from "@/config/operational";
import { formatCents } from "@/lib/pricing";
import { formatNZDate } from "@/lib/nzst-date";
import {
  AdminViewOnlyNotice,
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  LodgeSelect,
  initialLodgeIdFromLocation,
  useLodgeOptions,
} from "@/components/lodge-select";

// The Hut Fees section of the consolidated /admin/fees console (#1933, E7):
// per-lodge → per-season → membership-type × age-tier nightly rate grid (E4).
// This is where hut nightly rates AND seasons are created/edited (the season
// POST requires ≥1 rate, so a rate-less season cannot be created on the
// windows-only /admin/seasons page — creating a season with its rates lives
// here). Editing rates for an existing season PUTs membershipTypeRates; editing
// only a season's window metadata is done on /admin/seasons (which omits rates,
// leaving them untouched). All edit controls gate on `canEdit` (bookings:edit).

interface MembershipTypeRate {
  membershipTypeId: string;
  ageTier: AgeTier | null;
  pricePerNightCents: number;
}

interface Season {
  id: string;
  name: string;
  type: "WINTER" | "SUMMER";
  startDate: string;
  endDate: string;
  active: boolean;
  // Flat whole-lodge night rate in integer cents, or null when not set (#2338).
  flatWholeLodgeNightCents: number | null;
  membershipTypeRates: MembershipTypeRate[];
}

interface AgeTierSetting {
  tier: AgeTier;
  minAge: number;
  maxAge: number | null;
  label: string;
  sortOrder: number;
}

interface RateType {
  id: string;
  key: string;
  name: string;
  bookingBehavior: "MEMBER_RATE" | "NON_MEMBER_RATE" | "BLOCK_BOOKING";
  ageGroupsApply: boolean;
}

const FALLBACK_TIERS: AgeTierSetting[] = [
  { tier: "INFANT", minAge: 0, maxAge: 4, label: "Infant (under 5)", sortOrder: 0 },
  { tier: "CHILD", minAge: 5, maxAge: 9, label: "Child (5-9)", sortOrder: 1 },
  { tier: "YOUTH", minAge: 10, maxAge: 17, label: "Youth (10-17)", sortOrder: 2 },
  { tier: "ADULT", minAge: 18, maxAge: null, label: "Adult (18+)", sortOrder: 3 },
];

const FLAT_KEY = "FLAT";

function rateKey(membershipTypeId: string, ageTier: AgeTier | typeof FLAT_KEY): string {
  return `${membershipTypeId}::${ageTier}`;
}

/*
  #2264 — ONE hint per membership type's rate table, not one per rate cell: the
  grid is nested `.map()`s, so a per-cell hint would repeat the same example
  dozens of times. The rate boxes render inside a `.map()` too, so a hook cannot
  be called per table; the id is derived from the membership type id and spelled
  exactly once here.
*/
function rateHintId(membershipTypeId: string): string {
  return `rate-hint-${membershipTypeId}`;
}

function cellsForType(type: RateType, tiers: AgeTierSetting[]): Array<AgeTier | typeof FLAT_KEY> {
  return type.ageGroupsApply ? tiers.map((t) => t.tier) : [FLAT_KEY];
}

function emptyRates(types: RateType[], tiers: AgeTierSetting[]): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const type of types) {
    for (const cell of cellsForType(type, tiers)) {
      rates[rateKey(type.id, cell)] = 0;
    }
  }
  return rates;
}

function seasonToRatesMap(
  rows: MembershipTypeRate[],
  types: RateType[],
  tiers: AgeTierSetting[],
): Record<string, number> {
  const map = emptyRates(types, tiers);
  for (const row of rows) {
    map[rateKey(row.membershipTypeId, row.ageTier ?? FLAT_KEY)] = row.pricePerNightCents;
  }
  return map;
}

export function HutFeesSection({ canEdit }: { canEdit: boolean }) {
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [ageTiers, setAgeTiers] = useState<AgeTierSetting[]>(FALLBACK_TIERS);
  const [rateTypes, setRateTypes] = useState<RateType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Cross-area read: /api/admin/seasons is bookings-gated, so a finance-only
  // operator on the shared /admin/fees console gets a 403 here. Surface that as
  // a friendly read-only notice instead of a raw fetch-failed error (E7 review,
  // Lens-A F1). The read API area is intentionally left unchanged.
  const [forbidden, setForbidden] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const { lodges, loading: lodgesLoading } = useLodgeOptions("admin");
  const [lodgeId, setLodgeId] = useState<string | null>(initialLodgeIdFromLocation);

  const [name, setName] = useState("");
  // #2257 — the example lives UNDER the field, not inside it as grey pseudo-content.
  const nameHint = useFieldHint();
  const [type, setType] = useState<"WINTER" | "SUMMER">("WINTER");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [active, setActive] = useState(true);
  const [rates, setRates] = useState<Record<string, number>>({});
  // #2338: the season's flat whole-lodge night rate in integer cents, or null
  // when the club does not charge a flat whole-lodge rate for this season.
  const [flatWholeLodgeCents, setFlatWholeLodgeCents] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchAgeTiers = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/age-tier-settings");
      if (!res.ok) return;
      const data = await res.json();
      if (data.settings && data.settings.length > 0) {
        setAgeTiers(data.settings);
      }
    } catch {
      // Use fallback tiers
    }
  }, []);

  const fetchRateTypes = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/membership-types");
      if (!res.ok) return;
      const data = await res.json();
      const types: RateType[] = (data.membershipTypes ?? [])
        .filter(
          (t: RateType & { isActive: boolean }) =>
            t.isActive &&
            (t.bookingBehavior === "MEMBER_RATE" || t.key === "NON_MEMBER"),
        )
        .map((t: RateType) => ({
          id: t.id,
          key: t.key,
          name: t.name,
          bookingBehavior: t.bookingBehavior,
          ageGroupsApply: t.ageGroupsApply,
        }));
      setRateTypes(types);
    } catch {
      // No rate types available; the grid renders empty.
    }
  }, []);

  const fetchSeasons = useCallback(async (signal?: AbortSignal) => {
    try {
      const res = await fetch(
        lodgeId
          ? `/api/admin/seasons?lodgeId=${encodeURIComponent(lodgeId)}`
          : "/api/admin/seasons",
        { signal },
      );
      if (res.status === 403) {
        setForbidden(true);
        setError("");
        return;
      }
      if (!res.ok) throw new Error("Failed to fetch seasons");
      const data = await res.json();
      setForbidden(false);
      setSeasons(data);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [lodgeId]);

  useEffect(() => {
    fetchAgeTiers();
    fetchRateTypes();
  }, [fetchAgeTiers, fetchRateTypes]);

  useEffect(() => {
    const controller = new AbortController();
    fetchSeasons(controller.signal);
    return () => controller.abort();
  }, [fetchSeasons]);

  function resetForm() {
    setName("");
    setType("WINTER");
    setStartDate("");
    setEndDate("");
    setActive(true);
    setRates(emptyRates(rateTypes, ageTiers));
    setFlatWholeLodgeCents(null);
    setEditingId(null);
    setShowForm(false);
    setError("");
  }

  function startEdit(season: Season) {
    setEditingId(season.id);
    setName(season.name);
    setType(season.type);
    setStartDate(season.startDate.split("T")[0]);
    setEndDate(season.endDate.split("T")[0]);
    setActive(season.active);
    setRates(seasonToRatesMap(season.membershipTypeRates, rateTypes, ageTiers));
    setFlatWholeLodgeCents(season.flatWholeLodgeNightCents);
    setShowForm(true);
  }

  function startCreate() {
    setRates(emptyRates(rateTypes, ageTiers));
    setFlatWholeLodgeCents(null);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");

    const membershipTypeRates: MembershipTypeRate[] = Object.entries(rates).map(
      ([key, price]) => {
        const [membershipTypeId, tierPart] = key.split("::");
        return {
          membershipTypeId,
          ageTier: tierPart === FLAT_KEY ? null : (tierPart as AgeTier),
          pricePerNightCents: price,
        };
      },
    );

    const payload = {
      name,
      type,
      startDate,
      endDate,
      active,
      membershipTypeRates,
      // #2338: send the flat whole-lodge rate explicitly (null clears it) so an
      // edit here always reflects what the form shows. The windows-only Seasons
      // page never sends this field, so a window edit there leaves it untouched.
      flatWholeLodgeNightCents: flatWholeLodgeCents,
      ...(editingId ? {} : { lodgeId: lodgeId ?? undefined }),
    };

    try {
      const url = editingId
        ? `/api/admin/seasons/${editingId}`
        : "/api/admin/seasons";
      const method = editingId ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to save season");
      }

      resetForm();
      fetchSeasons();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Are you sure you want to delete this season?")) return;

    try {
      const res = await fetch(`/api/admin/seasons/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete");
      }
      fetchSeasons();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  async function handleToggleActive(season: Season) {
    try {
      const res = await fetch(`/api/admin/seasons/${season.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !season.active }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to update");
      }
      fetchSeasons();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    }
  }

  function handleRateChange(key: string, value: string) {
    const dollars = parseFloat(value);
    if (isNaN(dollars)) {
      setRates((prev) => ({ ...prev, [key]: 0 }));
    } else {
      setRates((prev) => ({ ...prev, [key]: Math.round(dollars * 100) }));
    }
  }

  // #2338: an EMPTY flat whole-lodge field means "no flat rate" (null), NOT $0 —
  // clearing it must switch the season back to per-guest whole-lodge pricing,
  // never charge nothing for the building. A typed dollar amount stores cents.
  function handleFlatWholeLodgeChange(value: string) {
    if (value.trim() === "") {
      setFlatWholeLodgeCents(null);
      return;
    }
    const dollars = parseFloat(value);
    setFlatWholeLodgeCents(isNaN(dollars) ? null : Math.round(dollars * 100));
  }

  /*
    #2160: the view-only explanation lives here, once, at the top of the section —
    announced on arrival and ahead of the controls it explains — instead of on
    each disabled button below. The `role="status"` wrapper is permanently
    mounted so the live region is registered in the accessibility tree before its
    content appears; a region injected already-populated is silently dropped by
    some screen-reader/browser pairings. It sits OUTSIDE the `space-y-6` stack so
    the empty wrapper an edit-capable admin gets costs no layout. Still gated on
    `!forbidden`: an admin who cannot even READ this section gets the stronger
    "no permission to view" notice below instead, and showing both would
    contradict itself.
  */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-6">
      Bookings view access can inspect hut fees. Bookings edit access is required to change nightly rates or seasons.
    </AdminViewOnlySectionBanner>
  );

  return (
    <Card>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <CardTitle>Hut fees</CardTitle>
          <CardDescription>
            Nightly hut rates per lodge, season, membership type, and age tier. Season windows
            (dates/active) are also editable on <Link href="/admin/seasons" className="underline">Seasons</Link>.
          </CardDescription>
        </div>
        {!forbidden && !showForm && canEdit && <Button onClick={startCreate}>Add season</Button>}
      </CardHeader>
      <CardContent>
        {!forbidden && viewOnlyBanner}
        <div className="space-y-6">
        {forbidden && (
          <AdminViewOnlyNotice canEdit={false}>
            You don&apos;t have permission to view this section. Hut fees are managed by
            bookings admins; ask a bookings admin if you need to see nightly rates.
          </AdminViewOnlyNotice>
        )}

        {!forbidden && (
        <div className="max-w-xs">
          <LodgeSelect lodges={lodges} value={lodgeId} onChange={setLodgeId} loading={lodgesLoading} />
        </div>
        )}

        {!forbidden && error && (
          <div role="alert" className="bg-destructive/10 text-destructive px-4 py-3 rounded-md">
            {error}
          </div>
        )}

        {forbidden ? null : loading ? (
          <p className="text-sm text-muted-foreground">Loading seasons…</p>
        ) : (
          <>
            {showForm && canEdit && (
              <Card>
                <CardHeader>
                  <CardTitle>{editingId ? "Edit Season" : "New Season"}</CardTitle>
                  <CardDescription>
                    Configure the season period and set rates for each membership type
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form onSubmit={handleSubmit} className="space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="name">Season Name</Label>
                        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required {...nameHint.fieldProps} />
                        <FieldHint {...nameHint.hintProps}>Example: Winter 2026</FieldHint>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="type">Type</Label>
                        <select
                          id="type"
                          value={type}
                          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setType(e.target.value as "WINTER" | "SUMMER")}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors"
                        >
                          <option value="WINTER">Winter</option>
                          <option value="SUMMER">Summer</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="startDate">Start Date</Label>
                        <Input id="startDate" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="endDate">End Date</Label>
                        <Input id="endDate" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
                      </div>
                    </div>

                    <div className="space-y-4">
                      <Label className="text-base font-semibold">Nightly Rates ({APP_CURRENCY})</Label>
                      <p className="text-sm text-muted-foreground">
                        Set the price per night for each membership type. Types with age
                        groups get a rate per age tier; flat types get a single rate.
                      </p>

                      {rateTypes.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No rate-bearing membership types found. Configure membership types first.
                        </p>
                      ) : (
                        <div className="space-y-6">
                          {rateTypes.map((rt) => (
                            <div key={rt.id}>
                              <h4 className="text-sm font-semibold mb-2">{rt.name}</h4>
                              {rt.ageGroupsApply ? (
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                                  {ageTiers.map((t) => {
                                    const key = rateKey(rt.id, t.tier);
                                    return (
                                      <div key={key} className="space-y-1">
                                        <Label htmlFor={`rate-${key}`} className="text-sm">{t.label}</Label>
                                        <div className="relative">
                                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                                          <Input
                                            id={`rate-${key}`}
                                            type="number"
                                            step="0.01"
                                            min="0"
                                            className="pl-7"
                                            value={rates[key] ? (rates[key] / 100).toFixed(2) : ""}
                                            onChange={(e) => handleRateChange(key, e.target.value)}
                                            aria-describedby={describedByFieldHint(rateHintId(rt.id))}
                                          />
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : (
                                <div className="max-w-xs space-y-1">
                                  <Label htmlFor={`rate-${rateKey(rt.id, FLAT_KEY)}`} className="text-sm">Flat rate (all ages)</Label>
                                  <div className="relative">
                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                                    <Input
                                      id={`rate-${rateKey(rt.id, FLAT_KEY)}`}
                                      type="number"
                                      step="0.01"
                                      min="0"
                                      className="pl-7"
                                      value={rates[rateKey(rt.id, FLAT_KEY)] ? (rates[rateKey(rt.id, FLAT_KEY)] / 100).toFixed(2) : ""}
                                      onChange={(e) => handleRateChange(rateKey(rt.id, FLAT_KEY), e.target.value)}
                                      aria-describedby={describedByFieldHint(rateHintId(rt.id))}
                                    />
                                  </div>
                                </div>
                              )}
                              <FieldHint id={rateHintId(rt.id)} className="mt-1">
                                Example: 45.00 per night
                              </FieldHint>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    {/*
                      #2338: the season's flat whole-lodge night rate. Optional —
                      leaving it blank keeps whole-lodge approvals priced per
                      guest. When set, a booking officer can choose "price as
                      whole lodge" on a member's whole-lodge approval to charge
                      nights x this rate regardless of headcount.
                    */}
                    <div className="space-y-2">
                      <Label htmlFor="flat-whole-lodge-rate" className="text-base font-semibold">
                        Flat whole-lodge night rate ({APP_CURRENCY}, optional)
                      </Label>
                      <p className="text-sm text-muted-foreground">
                        A single price per night for the whole building, regardless of how many
                        people come. Leave blank to price whole-lodge bookings per guest. When set,
                        a booking officer can choose &quot;price as whole lodge&quot; when they
                        approve a member&apos;s whole-lodge request, and the booking is charged this
                        rate per night instead of per guest.
                      </p>
                      <div className="relative max-w-xs">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                        <Input
                          id="flat-whole-lodge-rate"
                          type="number"
                          step="0.01"
                          min="0"
                          className="pl-7"
                          value={flatWholeLodgeCents != null ? (flatWholeLodgeCents / 100).toFixed(2) : ""}
                          onChange={(e) => handleFlatWholeLodgeChange(e.target.value)}
                          aria-describedby="flat-whole-lodge-rate-hint"
                        />
                      </div>
                      <FieldHint id="flat-whole-lodge-rate-hint" className="mt-1">
                        Example: 600.00 per night for the whole lodge
                      </FieldHint>
                    </div>

                    <div className="flex items-center space-x-2">
                      <input type="checkbox" id="active" checked={active} onChange={(e) => setActive(e.target.checked)} className="rounded border-input" />
                      <Label htmlFor="active">Active</Label>
                    </div>

                    <div className="flex space-x-3">
                      <Button type="submit" disabled={saving}>
                        {saving ? "Saving..." : editingId ? "Update Season" : "Create Season"}
                      </Button>
                      <Button type="button" variant="outline" onClick={resetForm}>Cancel</Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            )}

            {seasons.length === 0 ? (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  No seasons configured yet{canEdit ? '. Click "Add season" to get started.' : "."}
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                {seasons.map((season) => (
                  <Card key={season.id}>
                    <CardHeader>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-3">
                          <CardTitle className="text-xl">{season.name}</CardTitle>
                          <Badge variant={season.type === "WINTER" ? "default" : "secondary"}>{season.type}</Badge>
                          <Badge variant={season.active ? "default" : "outline"}>{season.active ? "Active" : "Inactive"}</Badge>
                        </div>
                        {canEdit && (
                          <div className="flex space-x-2">
                            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => handleToggleActive(season)}>
                              {season.active ? "Deactivate" : "Activate"}
                            </ViewOnlyActionButton>
                            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="outline" size="sm" onClick={() => startEdit(season)}>
                              Edit
                            </ViewOnlyActionButton>
                            <ViewOnlyActionButton canEdit={canEdit} describeReason={false} variant="destructive" size="sm" onClick={() => handleDelete(season.id)}>
                              Delete
                            </ViewOnlyActionButton>
                          </div>
                        )}
                      </div>
                      <CardDescription>
                        {formatNZDate(new Date(season.startDate))} &mdash;{" "}
                        {formatNZDate(new Date(season.endDate))}
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {/* #2338: the season's flat whole-lodge rate, shown only
                          when one is set. Absence reads as "priced per guest". */}
                      <p className="mb-4 text-sm">
                        <span className="font-semibold">Flat whole-lodge night rate: </span>
                        {season.flatWholeLodgeNightCents != null ? (
                          <span className="font-mono">
                            {formatCents(season.flatWholeLodgeNightCents)} per night
                          </span>
                        ) : (
                          <span className="text-muted-foreground">
                            Not set (whole-lodge bookings priced per guest)
                          </span>
                        )}
                      </p>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {rateTypes.map((rt) => (
                          <div key={rt.id}>
                            <h4 className="text-sm font-semibold mb-2">{rt.name}</h4>
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Age Group</TableHead>
                                  <TableHead className="text-right">Price/Night</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {rt.ageGroupsApply ? (
                                  ageTiers.map((t) => {
                                    const rate = season.membershipTypeRates.find(
                                      (r) => r.membershipTypeId === rt.id && r.ageTier === t.tier,
                                    );
                                    return (
                                      <TableRow key={t.tier}>
                                        <TableCell>{t.label}</TableCell>
                                        <TableCell className="text-right font-mono">
                                          {rate ? formatCents(rate.pricePerNightCents) : "Not set"}
                                        </TableCell>
                                      </TableRow>
                                    );
                                  })
                                ) : (
                                  (() => {
                                    const rate = season.membershipTypeRates.find(
                                      (r) => r.membershipTypeId === rt.id && r.ageTier === null,
                                    );
                                    return (
                                      <TableRow>
                                        <TableCell>All ages (flat)</TableCell>
                                        <TableCell className="text-right font-mono">
                                          {rate ? formatCents(rate.pricePerNightCents) : "Not set"}
                                        </TableCell>
                                      </TableRow>
                                    );
                                  })()
                                )}
                              </TableBody>
                            </Table>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </>
        )}
        </div>
      </CardContent>
    </Card>
  );
}
