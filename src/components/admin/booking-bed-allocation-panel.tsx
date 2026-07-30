"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { BedDouble, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  AdminViewOnlySectionBanner,
  ViewOnlyActionButton,
} from "@/components/admin/view-only-action";
import {
  BedRangeAssignDialog,
  type BedRangeAssignResult,
  type BedRangeAssignTarget,
  type BedRangeRefusalCategory,
  type RangeBedOptionGroup,
} from "@/components/admin/bed-range-assign-dialog";
import { useClubIdentity } from "@/components/club-identity-provider";
import {
  ADMIN_VIEW_ONLY_ACTION_REASON,
  useAdminAreaEditAccess,
} from "@/hooks/use-admin-area-edit-access";
import {
  MAX_RANGE_NIGHTS,
  collapseNightRuns,
  stayWindowPage,
} from "@/lib/bed-allocation-board-window";
import { buildHrefWithReturnTo } from "@/lib/internal-return-path";

/*
 * In-booking bed allocation (#2252, epic #2245 B2)
 * -----------------------------------------------
 * The board (/admin/bed-allocation) is the fine-grained, whole-lodge surface.
 * This panel answers the other question — "where is THIS booking's party
 * sleeping, and is it confirmed?" — without making an officer leave the booking
 * they are already looking at, cross-reference a date window, and find the
 * right chips among everyone else's.
 *
 * It invents no allocation machinery of its own. Reads reuse the dashboard GET;
 * assignment reuses #2251's shared range dialog and its atomic, attempt-first
 * range endpoint; removal reuses the existing DELETE. The single server change
 * behind it is the `bookingId` selector on the approve path (#2252), because
 * the approve route's other two selector forms cannot express "this booking's
 * drafts and nobody else's".
 *
 * Owner decisions signed off 29 Jul 2026:
 *   - ONE booking-level Confirm, not per-guest buttons;
 *   - a booking that cannot hold beds keeps the panel and gets an honest
 *     "not allocatable" note, rather than the panel silently vanishing;
 *   - its own "Bed allocation" card with a section-nav entry.
 */

// Structural mirrors of the dashboard payload, deliberately NOT imported from
// the admin route tree (the board's `_components/types.ts`) nor from the server
// lib: this component renders on the member-facing booking page. Only the
// fields the panel actually reads are declared.
interface PanelAllocation {
  id: string;
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: string;
  roomName: string;
  bedId: string;
  bedName: string;
  stayDate: string;
  source: "AUTO" | "MANUAL";
  approvedAt: string | null;
  approvedByName: string | null;
}

interface PanelGuestNight {
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  guestAgeTier: string;
  stayDate: string;
}

interface PanelBooking {
  id: string;
  status: string;
  memberName: string;
  wholeLodgeHold: boolean;
  overlapsExclusiveHold: boolean;
  guests?: Array<{ id: string; stayStart: string; stayEnd: string }>;
}

interface PanelExclusiveHold {
  bookingId: string;
  memberName: string;
  checkIn: string;
  checkOut: string;
  guestCount: number;
  nights: string[];
}

interface PanelRoom {
  id: string;
  name: string;
  sortOrder: number;
  active: boolean;
  beds: Array<{ id: string; name: string; sortOrder: number; active: boolean }>;
}

// A custodian bed hold overlapping the window (#2286): a bed held for a season
// by a hut-leader assignment, with NO booking and NO BedAllocation row
// anywhere. Structural mirror of the dashboard's DashboardCustodianHold, for
// the same reason as the mirrors above.
interface PanelCustodianHold {
  assignmentId: string;
  memberName: string;
  bedId: string;
  bedName: string;
  roomName: string;
  /** The hold's own inclusive range, so a note can state the whole season. */
  startDate: string;
  endDate: string;
  /** The held nights that fall within the window read. */
  nights: string[];
}

interface PanelPayload {
  range: { fromDate: string; toDate: string };
  rooms: PanelRoom[];
  bookings: PanelBooking[];
  allocations: PanelAllocation[];
  unallocatedGuestNights: PanelGuestNight[];
  exclusiveHolds: PanelExclusiveHold[];
  /*
   * Optional, and every read below tolerates its absence (#2286, the board's
   * own rule): during a deploy drain a new-colour browser bundle can be served
   * a payload from the old colour, which has no `custodianHolds` at all, and
   * crashing the booking page in that window would be worse than the drain
   * exposure the feature already accepts.
   */
  custodianHolds?: PanelCustodianHold[];
}

export interface BookingBedAllocationPanelProps {
  bookingId: string;
  /** ADR-003 board scope; null keeps the read club-wide, as the board does. */
  lodgeId: string | null;
  memberName: string;
  /** Date-only lodge nights: first night and check-out (exclusive). */
  checkIn: string;
  checkOut: string;
  /** ADR-001 exclusive whole-lodge hold on THIS booking. */
  wholeLodgeHold: boolean;
  bookingStatus: string;
  isDeleted: boolean;
  /*
   * Whether this booking's STATUS may own bed allocations at all — the server's
   * answer, from BED_ALLOCATABLE_BOOKING_STATUSES (#2252 review).
   *
   * This must be a passed fact, never inferred from the booking's absence from
   * the window payload: `loadBookingRecords` only returns bookings with at
   * least one guest night inside the window, so a perfectly allocatable booking
   * is absent whenever this PAGE's nights fall in a guest-stay gap, or the
   * booking has no guests at all. Inferring "cannot hold beds" from that told
   * the officer something false and hid the rows they came for.
   *
   * The constant lives in a module that imports prisma, so the page computes
   * this server-side rather than the panel importing it.
   */
  canHoldBeds: boolean;
  /*
   * How many of this booking's bed nights are already approved, counted across
   * the WHOLE booking rather than the page on screen (#2252 review). The
   * "removing these re-opens the member's room request" warning is a
   * booking-wide claim, and on a paged stay the window read cannot see the
   * confirmed nights on the other pages.
   */
  approvedBedNightCount: number;
  /** Already loaded by the page, so the rows have names before the fetch lands. */
  guests: Array<{ id: string; name: string }>;
}

/*
 * The custodian refusal category is the SERVER's, reached through the shared
 * range dialog's re-export (#2286) — imported, never re-declared. If the union
 * ever renames or drops the member, this line is a compile error here rather
 * than a marker that silently stops matching what the server refuses.
 */
const CUSTODIAN_HOLD = "CUSTODIAN_HOLD" satisfies BedRangeRefusalCategory;

/*
 * The board's custodian band treatment (#2286, owner decision 29 Jul): a
 * hatched NEUTRAL pattern plus a labelled pill — never colour-alone. Mirrors
 * CUSTODIAN_BAND_STYLE in the board's `board-cell.tsx` rather than importing
 * it, for the same reason as the payload mirrors above: this component renders
 * on the member-facing booking page and must not import from the admin route
 * tree. 1px `currentColor` stripes with 6px gaps — no opacity (the app-shell
 * theme contract bans endpoint-crossing alpha on text surfaces), inheriting
 * the surrounding `text-muted-foreground` so light and dark both work.
 */
const CUSTODIAN_BAND_STYLE: React.CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, currentColor 0, currentColor 1px, transparent 1px, transparent 7px)",
};

interface PlacedRun {
  key: string;
  bedId: string;
  bedName: string;
  roomName: string;
  firstNight: string;
  lastNight: string;
  nightCount: number;
  allocationIds: string[];
  draftCount: number;
  approvedCount: number;
  hasAutoSuggestion: boolean;
  /** Nights of this run that came from an AUTO suggestion, not a hand placement. */
  autoCount: number;
  /*
   * Nights of this run sitting on a bed-night a custodian holds (#2286).
   * Unreachable through the guarded write paths, so each one is evidence of a
   * pre-feature row or a deploy-drain write — the same anomaly the board
   * surfaces as its CUSTODIAN_BED_CONFLICT warning, shown here so the officer
   * looking at the booking sees it too instead of a clean-looking run.
   */
  custodianNights: string[];
}

interface GuestRow {
  id: string;
  name: string;
  ageTier: string | null;
  stayStart: string | null;
  stayEnd: string | null;
  runs: PlacedRun[];
  placedNightCount: number;
  unplacedNightCount: number;
}

interface RemoveTarget {
  guestName: string;
  run: PlacedRun;
}

async function readApiError(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

function nightWord(count: number) {
  return count === 1 ? "night" : "nights";
}

// Date-only lodge nights are ISO `YYYY-MM-DD`, so a lexicographic compare IS a
// chronological one. No Date objects, no timezone to get wrong.
function laterDate(left: string, right: string) {
  return left > right ? left : right;
}

function earlierDate(left: string, right: string) {
  return left < right ? left : right;
}

export function BookingBedAllocationPanel({
  bookingId,
  lodgeId,
  memberName,
  checkIn,
  checkOut,
  wholeLodgeHold,
  bookingStatus,
  isDeleted,
  canHoldBeds,
  approvedBedNightCount,
  guests,
}: BookingBedAllocationPanelProps) {
  // Same permission the board's write controls use: every affordance here is a
  // write, so a view-only admin sees the state and the reason, never a button
  // that would 403.
  const canEdit = useAdminAreaEditAccess("bookings");
  /*
   * Admin copy uses the club's own word for the role (#2286 review M8); only
   * the lobby TV is pinned to the fixed word "Custodian". This panel is
   * admin-only by construction (the page gates it with the admin-tools gate),
   * so no member ever receives the label — the owner's "no member-visible
   * custodian label" decision is preserved by the gate, not by wording.
   */
  const { hutLeaderLabel } = useClubIdentity();

  /*
   * Server truth, not an inference (#2252 review). A deleted booking holds no
   * beds; a booking in a status outside BED_ALLOCATABLE_BOOKING_STATUSES is
   * never allocated any. Both are known before a single byte is fetched, which
   * is why the read below is skipped entirely in that state — and why the
   * owner-mandated honest note can no longer be suppressed by a stale
   * `wholeLodgeHold` flag on a cancelled booking.
   */
  const notAllocatable = isDeleted || !canHoldBeds;

  const [pageIndex, setPageIndex] = useState(0);
  const [payload, setPayload] = useState<PanelPayload | null>(null);
  const [loading, setLoading] = useState(!notAllocatable);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<BedRangeAssignTarget | null>(
    null,
  );
  const [assignOpen, setAssignOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  /*
   * Bed nights this panel's own Confirm has approved since the server rendered
   * `approvedBedNightCount` (#2252 review). Confirm is booking-wide, so it can
   * approve nights on pages this window never read — which would otherwise
   * leave the booking-wide total stale LOW and let the "last confirmed nights"
   * warning fire when it is no longer true. Only Confirm is tracked: a removal
   * can only make the total stale HIGH, which suppresses the warning rather
   * than inventing one.
   */
  const [approvedSinceRender, setApprovedSinceRender] = useState(0);

  // The stay is paged in <=31-night windows because the dashboard read refuses
  // anything longer, and bookings have no maximum length. The page is always
  // LABELLED on screen — a window is never silently shortened (#2251's rule).
  const stayWindow = useMemo(
    () => stayWindowPage(checkIn, checkOut, pageIndex),
    [checkIn, checkOut, pageIndex],
  );

  const fromDate = stayWindow?.fromDate ?? checkIn;
  const toDate = stayWindow?.toDate ?? checkOut;

  /*
   * Stale-response guard (#2252 review). Two reads can be in flight at once —
   * step the page and press Refresh, or step twice quickly — and without
   * sequencing the SLOWER one wins, painting one window's rows under another
   * window's label. That is the same defect class #2251 has just fixed on the
   * board. A monotonic id is captured before the await and re-checked before
   * every state write; a superseded response is dropped in full, including its
   * error and its loading flag.
   */
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = requestSeq.current + 1;
    requestSeq.current = seq;
    const isCurrent = () => requestSeq.current === seq;
    setLoading(true);
    try {
      const params = new URLSearchParams({
        from: fromDate,
        to: toDate,
        bookingId,
      });
      if (lodgeId) params.set("lodgeId", lodgeId);
      const response = await fetch(
        `/api/admin/bed-allocation?${params.toString()}`,
      );
      if (!response.ok) {
        const message = await readApiError(
          response,
          "Failed to load bed allocation",
        );
        if (!isCurrent()) return;
        setPayload(null);
        setLoadError(message);
        return;
      }
      const body = (await response.json()) as PanelPayload;
      if (!isCurrent()) return;
      setPayload(body);
      setLoadError(null);
    } catch {
      if (!isCurrent()) return;
      setPayload(null);
      setLoadError("Failed to load bed allocation");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [bookingId, fromDate, toDate, lodgeId]);

  useEffect(() => {
    // A booking that cannot hold beds has nothing to read: the honest note is
    // server truth, so fetching a window to confirm it would be a pointless
    // round trip and a spinner in front of the answer.
    if (notAllocatable) return;
    void load();
  }, [load, notAllocatable]);

  /*
   * The `bookingId` query parameter does NOT server-filter the dashboard
   * payload — it only feeds `focusedBooking`. The whole window's data arrives,
   * so filtering to this booking is THIS component's job, and it is done once,
   * here, rather than at each render site.
   */
  const bookingRow = useMemo(
    () => payload?.bookings.find((booking) => booking.id === bookingId) ?? null,
    [payload, bookingId],
  );
  const hold = useMemo(
    () =>
      payload?.exclusiveHolds.find((entry) => entry.bookingId === bookingId) ??
      null,
    [payload, bookingId],
  );
  const allocations = useMemo(
    () =>
      (payload?.allocations ?? []).filter(
        (allocation) => allocation.bookingId === bookingId,
      ),
    [payload, bookingId],
  );
  const guestNights = useMemo(
    () =>
      (payload?.unallocatedGuestNights ?? []).filter(
        (night) => night.bookingId === bookingId,
      ),
    [payload, bookingId],
  );
  // Tolerant of the field's absence (old-colour drain payload) — see the
  // PanelPayload note. Every custodian read below goes through this list.
  const custodianHolds = useMemo(
    () => payload?.custodianHolds ?? [],
    [payload],
  );
  const custodianHeldBedNights = useMemo(() => {
    const map = new Map<string, PanelCustodianHold>();
    for (const hold of custodianHolds) {
      for (const night of hold.nights) map.set(`${hold.bedId}:${night}`, hold);
    }
    return map;
  }, [custodianHolds]);

  const bedOptionGroups = useMemo<RangeBedOptionGroup[]>(
    () =>
      [...(payload?.rooms ?? [])]
        .filter((room) => room.active)
        .sort((left, right) => left.sortOrder - right.sortOrder)
        .map((room) => ({
          roomId: room.id,
          roomName: room.name,
          beds: [...room.beds]
            .filter((bed) => bed.active)
            .sort((left, right) => left.sortOrder - right.sortOrder)
            .map((bed) => {
              /*
               * A custodian-held bed stays in the list — a hold may cover
               * only part of the range, and the server's per-night
               * CUSTODIAN_HOLD refusal is the authority — but its option
               * label says so up front (#2286), so the officer is not sent
               * on a round trip to learn what this payload already knew.
               */
              const holdsForBed = custodianHolds.filter(
                (hold) => hold.bedId === bed.id,
              );
              return {
                id: bed.id,
                bedName: bed.name,
                ...(holdsForBed.length > 0
                  ? {
                      heldNote: `held for a ${hutLeaderLabel.toLowerCase()} (${holdsForBed
                        .map((hold) => `${hold.startDate} → ${hold.endDate}`)
                        .join(", ")})`,
                    }
                  : {}),
              };
            }),
        }))
        .filter((group) => group.beds.length > 0),
    [payload, custodianHolds, hutLeaderLabel],
  );

  const rows = useMemo<GuestRow[]>(() => {
    const byId = new Map<string, GuestRow>();
    const ensure = (id: string, name: string) => {
      const existing = byId.get(id);
      if (existing) return existing;
      const created: GuestRow = {
        id,
        name,
        ageTier: null,
        stayStart: null,
        stayEnd: null,
        runs: [],
        placedNightCount: 0,
        unplacedNightCount: 0,
      };
      byId.set(id, created);
      return created;
    };

    // Seed from the page's own guest list so every guest has a row even before
    // the window read lands — and so a guest with no nights in THIS window is
    // still visibly part of the booking rather than silently missing.
    for (const guest of guests) ensure(guest.id, guest.name);
    for (const guest of bookingRow?.guests ?? []) {
      const row = byId.get(guest.id);
      if (!row) continue;
      row.stayStart = guest.stayStart;
      row.stayEnd = guest.stayEnd;
    }

    const nightsByGuestBed = new Map<string, PanelAllocation[]>();
    for (const allocation of allocations) {
      const row = ensure(allocation.bookingGuestId, allocation.guestName);
      row.name = allocation.guestName;
      row.ageTier = row.ageTier ?? allocation.guestAgeTier;
      row.placedNightCount += 1;
      const key = `${allocation.bookingGuestId}:${allocation.bedId}`;
      const bucket = nightsByGuestBed.get(key);
      if (bucket) bucket.push(allocation);
      else nightsByGuestBed.set(key, [allocation]);
    }

    for (const night of guestNights) {
      const row = ensure(night.bookingGuestId, night.guestName);
      row.name = night.guestName;
      row.ageTier = row.ageTier ?? night.guestAgeTier;
      row.unplacedNightCount += 1;
    }

    // A 90-night stay must not render 90 identical lines: contiguous nights on
    // the same bed collapse into one run, which is also the unit Remove acts on.
    for (const [key, group] of nightsByGuestBed) {
      const [guestId] = key.split(":");
      const row = byId.get(guestId);
      if (!row) continue;
      const byNight = new Map(group.map((item) => [item.stayDate, item]));
      for (const run of collapseNightRuns(group.map((it) => it.stayDate))) {
        const items = run.nights
          .map((night) => byNight.get(night))
          .filter((item): item is PanelAllocation => Boolean(item));
        row.runs.push({
          key: `${key}:${run.firstNight}`,
          bedId: group[0].bedId,
          bedName: group[0].bedName,
          roomName: group[0].roomName,
          firstNight: run.firstNight,
          lastNight: run.lastNight,
          nightCount: items.length,
          allocationIds: items.map((item) => item.id),
          draftCount: items.filter((item) => !item.approvedAt).length,
          approvedCount: items.filter((item) => item.approvedAt).length,
          hasAutoSuggestion: items.some((item) => item.source === "AUTO"),
          autoCount: items.filter((item) => item.source === "AUTO").length,
          custodianNights: items
            .filter((item) =>
              custodianHeldBedNights.has(`${item.bedId}:${item.stayDate}`),
            )
            .map((item) => item.stayDate),
        });
      }
    }

    for (const row of byId.values()) {
      row.runs.sort((left, right) =>
        left.firstNight.localeCompare(right.firstNight),
      );
    }

    return [...byId.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }, [allocations, guestNights, guests, bookingRow, custodianHeldBedNights]);

  const draftCount = allocations.filter(
    (allocation) => !allocation.approvedAt,
  ).length;
  const approvedCount = allocations.length - draftCount;
  const unplacedCount = guestNights.length;
  const paged = (stayWindow?.pageCount ?? 1) > 1;

  /*
   * The three states, each derived from what actually establishes it (#2252
   * review) rather than from one shared "absent from the payload" inference:
   *
   *   - notAllocatable — server truth (above): deleted, or a status that never
   *     owns beds. Checked FIRST, so a cancelled booking still carrying a stale
   *     `wholeLodgeHold` flag gets the owner-mandated honest note instead of
   *     reading as an active hold with nothing to do.
   *   - held — ADR-001: this booking takes the whole lodge, so it needs no
   *     individual beds. Only meaningful on a booking that could hold beds.
   *   - absentFromWindow — allocatable, not held, but this PAGE's nights carry
   *     no guest night of the booking, so the window read omits it. That is a
   *     statement about the page, not about the booking, and the rows and
   *     Confirm stay reachable (page through to the booking's real nights).
   */
  const held = !notAllocatable && (Boolean(hold) || wholeLodgeHold);
  const absentFromWindow =
    !notAllocatable && !held && Boolean(payload) && !bookingRow;

  const boardHref = buildHrefWithReturnTo(
    `/admin/bed-allocation?${new URLSearchParams({
      from: fromDate,
      to: toDate,
      bookingId,
      ...(lodgeId ? { lodgeId } : {}),
    }).toString()}`,
    `/bookings/${bookingId}`,
  );

  function openAssign(row: GuestRow) {
    setAssignTarget({
      bookingGuestId: row.id,
      bookingId,
      guestName: row.name,
      memberName,
      /*
       * The GUEST's own stay, never the booking's wider envelope: a guest who
       * joins late would otherwise be offered nights they are not booked for,
       * which the range endpoint refuses as GUEST_NOT_BOOKED.
       *
       * Clamped to the page on screen, and falling back to the PAGE window
       * rather than the booking envelope when the guest's stay is unknown
       * (#2252 review). The payload only carries stays for guests with a night
       * inside the window, so the fallback fires exactly on a long, paged stay
       * — where the envelope is both the wrong nights and longer than the
       * MAX_RANGE_NIGHTS the range endpoint will accept, so the dialog would
       * open pre-loaded with a request that cannot be written.
       */
      fromDate: laterDate(row.stayStart ?? fromDate, fromDate),
      toDate: earlierDate(row.stayEnd ?? toDate, toDate),
    });
    setAssignOpen(true);
  }

  function handleAssigned(result: BedRangeAssignResult) {
    toast.success(
      `${result.guestName} placed in ${result.roomName} / ${result.bedName} for ${result.writtenNights.length} ${nightWord(result.writtenNights.length)}`,
    );
    void load();
  }

  async function confirmBeds() {
    if (!canEdit) return;
    setBusy("confirm");
    try {
      const response = await fetch("/api/admin/bed-allocation/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        /*
         * The booking selector, plus the SAME lodge scope the panel read with
         * — and never `from`/`to`, which would confirm every other booking's
         * drafts in the same window (#2252).
         *
         * The lodge scope closes a write-wider-than-read gap the review found
         * (#2252 review): the panel's GET is lodge-scoped, so an anomalous row
         * of this booking sitting in ANOTHER lodge's room is invisible here.
         * Without `lodgeId` the approve would silently stamp it too, confirming
         * a bed nobody was shown. Scoped, Confirm can only ever approve what
         * the officer could see.
         */
        body: JSON.stringify({ bookingId, ...(lodgeId ? { lodgeId } : {}) }),
      });
      if (!response.ok) {
        toast.error(await readApiError(response, "Failed to confirm beds"));
        return;
      }
      const body = (await response.json()) as { approvedCount?: number };
      const count = body.approvedCount ?? 0;
      // Keep the booking-wide approved total honest for the removal warning,
      // including the nights this window cannot see.
      if (count > 0) setApprovedSinceRender((total) => total + count);
      toast.success(
        count > 0
          ? `Confirmed ${count} bed ${nightWord(count)} for this booking`
          : "Nothing left to confirm — every bed night was already approved",
      );
      await load();
    } catch {
      toast.error("Failed to confirm beds");
    } finally {
      setBusy(null);
    }
  }

  async function removeRun(target: RemoveTarget) {
    if (!canEdit) return;
    setBusy(`remove:${target.run.key}`);
    let removed = 0;
    let failure: string | null = null;
    try {
      /*
       * One DELETE per night. There is deliberately no bulk-remove endpoint,
       * and inventing one is out of scope for this issue — so the outcome is
       * reported honestly instead of assumed: a run that stops halfway says how
       * many nights actually went.
       */
      for (const id of target.run.allocationIds) {
        const response = await fetch(
          `/api/admin/bed-allocation/allocations/${id}`,
          { method: "DELETE" },
        );
        if (!response.ok) {
          failure = await readApiError(response, "Failed to remove a bed night");
          break;
        }
        removed += 1;
      }
    } catch {
      failure = "Failed to remove a bed night";
    } finally {
      setBusy(null);
      setRemoveTarget(null);
      await load();
    }

    if (failure) {
      toast.error(
        removed > 0
          ? `${failure} — ${removed} of ${target.run.allocationIds.length} ${nightWord(target.run.allocationIds.length)} were removed.`
          : failure,
      );
      return;
    }
    toast.success(
      `Removed ${removed} bed ${nightWord(removed)} for ${target.guestName}`,
    );
  }

  /*
   * Hoisted so the live region is mounted in every branch this component can
   * render (#2160): a `role="status"` that only appears once the fetch settles
   * is registered already-populated, and some screen readers drop it.
   */
  const viewOnlyBanner = (
    <AdminViewOnlySectionBanner canEdit={canEdit} className="mb-4">
      You can see where this booking is sleeping, but not assign, remove, or
      confirm beds.
    </AdminViewOnlySectionBanner>
  );

  /*
   * Removing the booking's last approved night legitimately re-opens the
   * member's room-request editor (#776). The lock is not one-way, and the
   * officer is told which case they are in rather than being left to find out.
   *
   * The claim is booking-wide, so it cannot be decided from the page's own
   * `approvedCount` alone (#2252 review): on a paged stay, confirmed nights on
   * another page would make the warning simply false. The booking-wide total
   * comes from the server, and only ever SUPPRESSES the warning — so the one
   * way it can drift (this panel's own Confirm approving nights off-page since
   * the page rendered) is corrected by adding what Confirm actually reported,
   * and drift in the other direction (rows removed elsewhere) can only omit a
   * warning, never invent one.
   */
  const bookingApprovedCount = approvedBedNightCount + approvedSinceRender;
  const approvedElsewhereOnBooking = Math.max(
    bookingApprovedCount - approvedCount,
    0,
  );
  const removingLastApproved =
    removeTarget !== null &&
    removeTarget.run.approvedCount > 0 &&
    removeTarget.run.approvedCount >= approvedCount &&
    approvedElsewhereOnBooking === 0;

  return (
    <Card id="bed-allocation" className="scroll-mt-20">
      <CardHeader className="pb-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <BedDouble className="h-4 w-4" aria-hidden />
          Bed allocation
          {/* Both counts are this PAGE's, so on a paged stay the badge carries
              the same "(this page)" qualifier the rows and Confirm already use
              (#2252 review) — a stay whose other pages are still in draft must
              not read as flatly "Confirmed". */}
          {approvedCount > 0 ? (
            <Badge variant="success" data-testid="bed-card-status-badge">
              {paged ? "Confirmed (this page)" : "Confirmed"}
            </Badge>
          ) : draftCount > 0 ? (
            <Badge variant="warning" data-testid="bed-card-status-badge">
              {paged ? "Draft (this page)" : "Draft"}
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {viewOnlyBanner}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-muted-foreground" data-testid="bed-window-label">
            {stayWindow
              ? paged
                ? `Nights ${stayWindow.firstNight}–${stayWindow.lastNight} of ${stayWindow.totalNights} · ${stayWindow.fromDate} → ${stayWindow.toDate}`
                : `${stayWindow.totalNights} ${nightWord(stayWindow.totalNights)} · ${stayWindow.fromDate} → ${stayWindow.toDate}`
              : `${checkIn} → ${checkOut}`}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {/* No window read happens for a booking that cannot hold beds, so
                paging and Refresh would drive nothing. The board link stays —
                it is still the way to see the nights around this booking. */}
            {paged && !notAllocatable ? (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Earlier nights"
                  disabled={pageIndex === 0 || loading}
                  onClick={() => setPageIndex((index) => Math.max(index - 1, 0))}
                >
                  <ChevronLeft className="h-4 w-4" aria-hidden />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="Later nights"
                  disabled={
                    !stayWindow ||
                    pageIndex >= stayWindow.pageCount - 1 ||
                    loading
                  }
                  onClick={() => setPageIndex((index) => index + 1)}
                >
                  <ChevronRight className="h-4 w-4" aria-hidden />
                </Button>
              </>
            ) : null}
            {!notAllocatable ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => void load()}
              >
                <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
                Refresh
              </Button>
            ) : null}
            <Link href={boardHref}>
              <Button type="button" variant="outline" size="sm">
                Open on the board
              </Button>
            </Link>
          </div>
        </div>

        {paged && !notAllocatable ? (
          <p className="text-xs text-muted-foreground">
            This stay is longer than the {MAX_RANGE_NIGHTS}-night window the
            allocation read allows, so it is shown a page at a time. Nothing is
            hidden — step through the pages to see the rest.
          </p>
        ) : null}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" label="Loading bed allocation…" />
            Loading bed allocation…
          </div>
        ) : null}

        {loadError ? <Alert variant="error">{loadError}</Alert> : null}

        {/* Server truth, so it needs no fetch to settle behind it (#2252
            review). A deleted or non-allocatable booking says so immediately,
            and — crucially — says so even when it still carries a stale
            `wholeLodgeHold` flag, which used to swallow this note entirely. */}
        {notAllocatable ? (
          <Alert variant="info" title="This booking cannot hold beds">
            <p data-testid="bed-not-allocatable">
              {isDeleted
                ? "This booking is deleted, so it holds no beds and cannot be allocated."
                : `A ${bookingStatus.toLowerCase().replace(/_/g, " ")} booking is not allocated beds, so there is nothing to place or confirm here.`}{" "}
              Any beds it once held were released.
            </p>
          </Alert>
        ) : null}

        {/* Allocatable, unheld, and simply not on THIS page — a statement about
            the window, never about the booking (#2252 review). The rows and
            Confirm below stay reachable: on a paged stay the booking's nights
            are on another page, and Confirm is booking-wide regardless. */}
        {!loading && !loadError && absentFromWindow ? (
          <Alert variant="info" title="No nights of this booking on this page">
            <p data-testid="bed-absent-this-window">
              No guest of this booking is booked on any night of this page, so
              there are no stays to place here.{" "}
              {paged
                ? "Step through the pages to reach the nights its guests are on."
                : "This booking can hold beds — check its guests and their stay dates."}
            </p>
          </Alert>
        ) : null}

        {!loading && !loadError && held ? (
          <Alert
            variant="info"
            title="Exclusive whole-lodge hold — no per-bed allocation needed"
          >
            <p data-testid="bed-exclusive-hold">
              This booking holds the whole lodge for its nights, so its guests
              take the lodge rather than individual beds. There is nothing to
              assign or confirm while the hold stands.
            </p>
            {hold ? (
              <p className="mt-1 text-xs">
                {hold.memberName} · {hold.checkIn} → {hold.checkOut} ·{" "}
                {hold.guestCount} guest{hold.guestCount === 1 ? "" : "s"}
              </p>
            ) : null}
          </Alert>
        ) : null}

        {!loading && !loadError && bookingRow?.overlapsExclusiveHold ? (
          <Alert variant="warning" title="Overlaps another booking's whole-lodge hold">
            Another booking holds the whole lodge on some of these nights. Beds
            can still be assigned here, but the clash needs resolving before
            anyone arrives.
          </Alert>
        ) : null}

        {/* Custodian bed holds in this window (#2286): the same honest
            availability note the board gives, because Assign… below offers
            every active bed and the server refuses a held bed-night with a
            CUSTODIAN_HOLD report — the officer should read it here first, not
            discover it as a refusal. Copy mirrors the board's; the role word is
            the club's own (only the lobby TV is pinned to "Custodian"). */}
        {!loading && !loadError && !notAllocatable && !held &&
        custodianHolds.length > 0 ? (
          <Alert
            variant="info"
            title={`Bed held for a ${hutLeaderLabel.toLowerCase()} — not available to allocate`}
          >
            <p className="mb-1" data-testid="bed-custodian-holds">
              {custodianHolds.length === 1 ? "This bed is" : "These beds are"}{" "}
              held for a {hutLeaderLabel.toLowerCase()} with no booking, so no
              guest can be placed on them for those nights. Change the dates or
              the bed on the{" "}
              <Link className="underline" href="/admin/hut-leaders">
                {hutLeaderLabel} Assignments
              </Link>{" "}
              page.
            </p>
            <ul className="space-y-1">
              {custodianHolds.map((hold) => (
                <li key={hold.assignmentId}>
                  <span className="font-medium">{hold.memberName}</span> ·{" "}
                  {hold.roomName} · {hold.bedName} · {hold.startDate} →{" "}
                  {hold.endDate}
                </li>
              ))}
            </ul>
          </Alert>
        ) : null}

        {!loading && !loadError && !notAllocatable && !held ? (
          <div className="space-y-3" data-testid="bed-guest-rows">
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                This booking has no guests to place.
              </p>
            ) : null}
            {rows.map((row) => (
              <div key={row.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium">{row.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {row.ageTier ? `${row.ageTier.toLowerCase()} · ` : ""}
                      {row.stayStart && row.stayEnd
                        ? `${row.stayStart} → ${row.stayEnd}`
                        : `${checkIn} → ${checkOut}`}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {row.placedNightCount} placed ·{" "}
                      {row.unplacedNightCount} not placed
                      {paged ? " (this page)" : ""}
                    </div>
                  </div>
                  <ViewOnlyActionButton
                    canEdit={canEdit}
                    describeReason={false}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => openAssign(row)}
                  >
                    Assign…
                  </ViewOnlyActionButton>
                </div>

                {row.runs.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {row.runs.map((run) => (
                      <li
                        key={run.key}
                        className="flex flex-wrap items-center gap-2 text-xs"
                      >
                        <span className="font-medium">
                          {run.roomName} / {run.bedName}
                        </span>
                        <span className="font-mono text-muted-foreground">
                          {run.firstNight}
                          {run.nightCount > 1 ? ` → ${run.lastNight}` : ""}
                        </span>
                        <span className="text-muted-foreground">
                          {run.nightCount} {nightWord(run.nightCount)}
                        </span>
                        {run.draftCount > 0 ? (
                          <Badge variant="warning">
                            Draft{run.approvedCount > 0 ? " in part" : ""}
                          </Badge>
                        ) : (
                          <Badge variant="success">Confirmed</Badge>
                        )}
                        {/* "in part" for the same reason the Draft badge
                            carries it (#2252 review): a run that is half
                            hand-placed and half machine-suggested must not read
                            as wholly suggested. */}
                        {run.hasAutoSuggestion ? (
                          <Badge variant="outline">
                            Suggested
                            {run.autoCount < run.nightCount ? " in part" : ""}
                          </Badge>
                        ) : null}
                        {/* A run sitting on custodian-held bed-nights (#2286)
                            is the board's CUSTODIAN_BED_CONFLICT, seen from
                            the booking: blocked, never clean-looking. The
                            hatching is the board cell's own neutral treatment
                            and is a second, redundant signal — the labelled
                            pill carries the meaning, never colour (or pattern)
                            alone. The title copy is the shared dialog's for
                            the same CUSTODIAN_HOLD category. */}
                        {run.custodianNights.length > 0 ? (
                          <span
                            data-testid="bed-run-custodian-hold"
                            data-refusal-category={CUSTODIAN_HOLD}
                            style={CUSTODIAN_BAND_STYLE}
                            className="inline-flex items-center rounded-md border border-dashed px-1.5 py-0.5 text-muted-foreground"
                            title={`Held for a ${hutLeaderLabel.toLowerCase()} on ${run.custodianNights.join(", ")} — remove the allocation, or change the assignment on the ${hutLeaderLabel} Assignments page.`}
                          >
                            <span className="rounded-full bg-background px-1.5 font-semibold uppercase tracking-wide">
                              Held for a {hutLeaderLabel.toLowerCase()}
                              {run.custodianNights.length < run.nightCount
                                ? " in part"
                                : ""}
                            </span>
                          </span>
                        ) : null}
                        <ViewOnlyActionButton
                          canEdit={canEdit}
                          describeReason={false}
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy === `remove:${run.key}`}
                          onClick={() =>
                            setRemoveTarget({ guestName: row.name, run })
                          }
                        >
                          Remove
                        </ViewOnlyActionButton>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    No bed on any night of this page.
                  </p>
                )}
              </div>
            ))}

            <div className="rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-sm">
                  <div className="font-medium">Confirm beds</div>
                  <div className="text-xs text-muted-foreground">
                    {draftCount} draft bed {nightWord(draftCount)} ·{" "}
                    {approvedCount} already confirmed
                    {paged ? " on this page" : ""}
                  </div>
                </div>
                <ViewOnlyActionButton
                  canEdit={canEdit}
                  describeReason={false}
                  type="button"
                  disabled={
                    busy === "confirm" || (!paged && draftCount === 0)
                  }
                  onClick={() => void confirmBeds()}
                >
                  {busy === "confirm" ? "Confirming…" : "Confirm draft beds"}
                </ViewOnlyActionButton>
              </div>
              {unplacedCount > 0 ? (
                <p className="mt-2 text-xs text-warning">
                  {unplacedCount} guest {nightWord(unplacedCount)} on this page
                  still {unplacedCount === 1 ? "has" : "have"} no bed.
                  Confirming does not place them.
                </p>
              ) : null}
              {paged ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Confirm covers every draft bed night of this booking,
                  including nights outside the page shown above.
                </p>
              ) : null}
              <p className="mt-2 text-xs text-muted-foreground">
                Confirming approves this booking&apos;s draft beds and nobody
                else&apos;s. It also locks the member out of changing their
                requested room — under range assignment that lock may already be
                on, because a range assign approves as it writes.
              </p>
            </div>
          </div>
        ) : null}
      </CardContent>

      <BedRangeAssignDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        target={assignTarget}
        bedOptionGroups={bedOptionGroups}
        canEdit={canEdit}
        onAssigned={handleAssigned}
      />

      <Dialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove these bed nights?</DialogTitle>
            <DialogDescription>
              {removeTarget
                ? `${removeTarget.guestName} will lose ${removeTarget.run.nightCount} ${nightWord(removeTarget.run.nightCount)} in ${removeTarget.run.roomName} / ${removeTarget.run.bedName}.`
                : null}
            </DialogDescription>
          </DialogHeader>
          {removingLastApproved ? (
            <Alert variant="warning" data-testid="bed-remove-reopens-lock">
              These are the last confirmed bed nights on this booking. Removing
              them re-opens the member&apos;s room request for editing.
            </Alert>
          ) : null}
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRemoveTarget(null)}
            >
              Cancel
            </Button>
            {/* A dialog is its own accessibility container: the card's
                view-only banner does not reach inside it, so this control
                carries the reason itself — the same shape the shared range
                dialog uses (#2251). */}
            <Button
              type="button"
              variant="destructive"
              disabled={!canEdit || busy !== null}
              title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
              onClick={() => {
                if (removeTarget) void removeRun(removeTarget);
              }}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
