"use client";

import { useEffect, useMemo, useState } from "react";
import { BedDouble, CircleDashed, Lock, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ADMIN_VIEW_ONLY_ACTION_REASON } from "@/hooks/use-admin-area-edit-access";
import {
  eachDateOnlyInRange,
  formatDateOnly,
  isDateOnlyString,
  parseDateOnly,
} from "@/lib/date-only";

/*
 * Range assignment dialog (#2251) — "put this guest in this bed from X to Y" for
 * a stay of any length.
 *
 * There is deliberately NO preview step (owner decision, 26 Jul 2026). Assign
 * attempts the whole range atomically; if anything blocks it, NOTHING is written
 * and the server's refusal report is rendered here in its three categories. Only
 * then does a second, explicit "Assign the N free nights" action appear.
 *
 * Lives in src/components/admin (not the board's _components) because #2252
 * drives the same dialog from inside a booking — one component, two surfaces.
 */

// Mirrors the board's BedOptionGroup structurally without importing from the
// admin route tree, so the booking surface can build its own options.
export interface RangeBedOptionGroup {
  roomId: string;
  roomName: string;
  beds: { id: string; bedName: string }[];
}

export type BedRangeRefusalCategory =
  | "EXCLUSIVE_HOLD"
  | "GUEST_NOT_BOOKED"
  | "BED_TAKEN";

export interface BedRangeRefusal {
  stayDate: string;
  category: BedRangeRefusalCategory;
  occupiedBy?: {
    guestName: string;
    memberName: string;
    bookingId: string;
    holdsCapacity: boolean;
  };
  hold?: { bookingId: string; memberName: string; ownBooking: boolean };
}

export interface BedRangeAssignResult {
  applied: boolean;
  freeNightsOnly: boolean;
  bookingId: string;
  bookingGuestId: string;
  guestName: string;
  bedId: string;
  bedName: string;
  roomName: string;
  fromDate: string;
  toDate: string;
  requestedNights: string[];
  freeNights: string[];
  writtenNights: string[];
  refusals: BedRangeRefusal[];
}

export interface BedRangeAssignTarget {
  bookingGuestId: string;
  bookingId: string;
  guestName: string;
  memberName?: string;
  bedId?: string;
  // First night / check-out (exclusive) to prefill, normally the guest's stay.
  fromDate: string;
  toDate: string;
}

interface BedRangeAssignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: BedRangeAssignTarget | null;
  bedOptionGroups: RangeBedOptionGroup[];
  // Tri-state (#2065): `undefined` while the client session resolves; the
  // `!canEdit` idiom treats that as disabled, so no truthy default here.
  canEdit: boolean | undefined;
  onAssigned: (result: BedRangeAssignResult) => void;
}

// Mirrors MAX_BED_ALLOCATION_ASSIGN_RANGE_NIGHTS in
// src/lib/admin-bed-allocation.ts. The client refuses too, so a mistyped year
// is caught before a pointless round trip — it never shortens the range.
export const MAX_RANGE_ASSIGN_NIGHTS = 366;

const CATEGORY_ORDER: BedRangeRefusalCategory[] = [
  "BED_TAKEN",
  "GUEST_NOT_BOOKED",
  "EXCLUSIVE_HOLD",
];

const CATEGORY_TITLE: Record<BedRangeRefusalCategory, string> = {
  BED_TAKEN: "Bed already allocated",
  GUEST_NOT_BOOKED: "Guest is not booked that night",
  EXCLUSIVE_HOLD: "Whole-lodge hold",
};

const CATEGORY_EXPLANATION: Record<BedRangeRefusalCategory, string> = {
  BED_TAKEN:
    "Someone else is in this bed on these nights. Nothing was overwritten.",
  GUEST_NOT_BOOKED:
    "This is not a clash — it means the range or the guest is wrong. Check the dates before going further.",
  EXCLUSIVE_HOLD:
    "These nights sit inside an exclusive whole-lodge hold, which takes the whole lodge and needs no per-bed allocation.",
};

export function nightsBetween(fromDate: string, toDate: string): string[] {
  if (!isDateOnlyString(fromDate) || !isDateOnlyString(toDate)) return [];
  const from = parseDateOnly(fromDate);
  const to = parseDateOnly(toDate);
  if (to <= from) return [];
  return eachDateOnlyInRange(from, to).map(formatDateOnly);
}

// Refuse, never truncate (#2251 requirement 4). Returns the reason a range
// cannot be sent, or null when it is well-formed.
export function rangeAssignError(
  fromDate: string,
  toDate: string,
): string | null {
  if (!isDateOnlyString(fromDate) || !isDateOnlyString(toDate)) {
    return "Enter a first night and a date out.";
  }
  if (parseDateOnly(toDate) <= parseDateOnly(fromDate)) {
    return "Date out must be after date in.";
  }
  const nights = nightsBetween(fromDate, toDate).length;
  if (nights > MAX_RANGE_ASSIGN_NIGHTS) {
    return `A range assignment covers at most ${MAX_RANGE_ASSIGN_NIGHTS} nights; that range is ${nights}. Split it into shorter ranges.`;
  }
  return null;
}

export function BedRangeAssignDialog({
  open,
  onOpenChange,
  target,
  bedOptionGroups,
  canEdit,
  onAssigned,
}: BedRangeAssignDialogProps) {
  const [bedId, setBedId] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<BedRangeAssignResult | null>(null);

  // Re-seed from the target each time the dialog opens, so reopening from a
  // different guest or bed never inherits the previous attempt's state.
  useEffect(() => {
    if (!open || !target) return;
    setBedId(target.bedId ?? "");
    setFromDate(target.fromDate);
    setToDate(target.toDate);
    setRefusal(null);
    setSubmitting(false);
  }, [open, target]);

  const nights = useMemo(
    () => nightsBetween(fromDate, toDate),
    [fromDate, toDate],
  );
  const validationError = useMemo(
    () => rangeAssignError(fromDate, toDate),
    [fromDate, toDate],
  );

  const refusalsByCategory = useMemo(() => {
    const map = new Map<BedRangeRefusalCategory, BedRangeRefusal[]>();
    for (const item of refusal?.refusals ?? []) {
      const existing = map.get(item.category);
      if (existing) {
        existing.push(item);
      } else {
        map.set(item.category, [item]);
      }
    }
    return map;
  }, [refusal]);

  if (!target) return null;

  async function submit(freeNightsOnly: boolean) {
    if (!canEdit || !target) return;
    if (!bedId) {
      toast.error("Select a bed first");
      return;
    }
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(
        "/api/admin/bed-allocation/allocations/range",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookingGuestId: target.bookingGuestId,
            bedId,
            from: fromDate,
            to: toDate,
            ...(freeNightsOnly ? { freeNightsOnly: true } : {}),
          }),
        },
      );

      const body = (await response.json().catch(() => null)) as {
        error?: string;
        result?: BedRangeAssignResult;
      } | null;

      // A refused attempt is not an error to swallow: the server answers 400/409
      // and carries the report that tells the admin exactly what blocked it.
      if (body?.result && !body.result.applied) {
        setRefusal(body.result);
        return;
      }

      if (!response.ok || !body?.result) {
        toast.error(body?.error ?? "Failed to assign the range");
        return;
      }

      onAssigned(body.result);
      onOpenChange(false);
    } catch {
      toast.error("Failed to assign the range");
    } finally {
      setSubmitting(false);
    }
  }

  const freeNightCount = refusal?.freeNights.length ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BedDouble className="h-4 w-4" aria-hidden />
            Assign a range of nights
          </DialogTitle>
          <DialogDescription>
            Put {target.guestName} in one bed for every night of the range. It is
            written all at once — if any night is blocked, nothing is written and
            you are shown exactly which nights and why.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Opaque muted token, never an alpha of it: the app-shell theme
              contract bans endpoint-crossing opacity variants on text
              surfaces (and scans this file's source, comments included). */}
          <div className="rounded-md border bg-muted p-3 text-sm">
            <div className="font-medium">{target.guestName}</div>
            {target.memberName ? (
              <div className="text-xs text-muted-foreground">
                {target.memberName}
              </div>
            ) : null}
            <div className="font-mono text-xs text-muted-foreground">
              {target.bookingId}
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="bed-range-bed">Bed</Label>
            <Select
              value={bedId}
              onValueChange={(value) => {
                setBedId(value);
                // The report describes the attempt that produced it. Editing the
                // bed or the dates makes it stale evidence, so drop it rather
                // than leave the admin reading a refusal for a different range.
                setRefusal(null);
              }}
              disabled={!canEdit}
            >
              <SelectTrigger id="bed-range-bed">
                <SelectValue placeholder="Select bed" />
              </SelectTrigger>
              <SelectContent>
                {bedOptionGroups.map((room) => (
                  <SelectGroup key={room.roomId}>
                    <SelectLabel>{room.roomName}</SelectLabel>
                    {room.beds.map((bed) => (
                      <SelectItem key={bed.id} value={bed.id}>
                        {room.roomName} / {bed.bedName}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="bed-range-from">Date In (first night)</Label>
              <Input
                id="bed-range-from"
                type="date"
                value={fromDate}
                disabled={!canEdit}
                onChange={(event) => {
                  setFromDate(event.target.value);
                  setRefusal(null);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="bed-range-to">Date Out (checkout)</Label>
              <Input
                id="bed-range-to"
                type="date"
                value={toDate}
                disabled={!canEdit}
                onChange={(event) => {
                  setToDate(event.target.value);
                  setRefusal(null);
                }}
              />
            </div>
          </div>

          <p className="text-xs text-muted-foreground" data-testid="range-summary">
            {nights.length > 0
              ? `${nights.length} night${nights.length === 1 ? "" : "s"} · first night ${nights[0]} · last night ${nights[nights.length - 1]}`
              : "No nights selected yet."}
          </p>

          {validationError ? (
            <Alert variant="error">{validationError}</Alert>
          ) : null}

          {/*
            Under the auto-approve decision the LOCK fires on the FIRST range
            assign, not on a later "Confirm" — isBookingBedAllocationLocked is
            "at least one approved row exists" (#776). Say so before the admin
            commits, not after.
          */}
          <Alert variant="warning" title="This confirms the beds straight away">
            Range assignments are approved as they are written. Approving beds
            locks this booking&apos;s member out of changing their requested room.
          </Alert>

          {refusal ? (
            <div className="space-y-3" data-testid="range-refusal-report">
              <Alert
                variant="error"
                title={`Nothing was written — ${refusal.refusals.length} of ${refusal.requestedNights.length} nights are blocked`}
              >
                {freeNightCount > 0
                  ? `${freeNightCount} night${freeNightCount === 1 ? " is" : "s are"} free. You can assign just those with the button below.`
                  : "No night in this range is free, so there is nothing to assign."}
              </Alert>

              {CATEGORY_ORDER.map((category) => {
                const items = refusalsByCategory.get(category) ?? [];
                if (items.length === 0) return null;
                return (
                  <div
                    key={category}
                    data-testid={`refusal-category-${category}`}
                    className="rounded-md border p-3"
                  >
                    <div className="flex items-center gap-2 text-sm font-semibold">
                      <TriangleAlert
                        className="h-4 w-4 text-warning"
                        aria-hidden
                      />
                      {CATEGORY_TITLE[category]} · {items.length} night
                      {items.length === 1 ? "" : "s"}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {CATEGORY_EXPLANATION[category]}
                    </p>
                    <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">
                      {items.map((item) => (
                        <li
                          key={`${item.category}:${item.stayDate}`}
                          className="flex flex-wrap items-center gap-2"
                        >
                          <span className="font-mono">{item.stayDate}</span>
                          {item.occupiedBy ? (
                            <>
                              <span>{item.occupiedBy.guestName}</span>
                              <span className="text-muted-foreground">
                                ({item.occupiedBy.memberName})
                              </span>
                              <span
                                className={
                                  item.occupiedBy.holdsCapacity
                                    ? "inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium text-secondary-foreground"
                                    : "inline-flex items-center gap-1 rounded-full border border-dashed border-muted-foreground/80 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                                }
                                title={
                                  item.occupiedBy.holdsCapacity
                                    ? "Held — this booking holds the bed for the night."
                                    : "Provisional — this booking does not hold the night, but it is still a conflict: nothing is overwritten without you saying so."
                                }
                              >
                                {item.occupiedBy.holdsCapacity ? (
                                  <Lock className="h-2.5 w-2.5" aria-hidden />
                                ) : (
                                  <CircleDashed
                                    className="h-2.5 w-2.5"
                                    aria-hidden
                                  />
                                )}
                                {item.occupiedBy.holdsCapacity
                                  ? "Held"
                                  : "Provisional"}
                              </span>
                            </>
                          ) : null}
                          {item.hold ? (
                            <span className="text-muted-foreground">
                              {item.hold.ownBooking
                                ? "This booking holds the whole lodge"
                                : `Held by ${item.hold.memberName}`}{" "}
                              ({item.hold.bookingId})
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <div className="flex flex-wrap gap-2">
            {refusal && freeNightCount > 0 ? (
              <Button
                type="button"
                variant="secondary"
                disabled={!canEdit || submitting}
                title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
                onClick={() => void submit(true)}
              >
                Assign the {freeNightCount} free night
                {freeNightCount === 1 ? "" : "s"}
              </Button>
            ) : null}
            <Button
              type="button"
              disabled={
                !canEdit || submitting || !bedId || Boolean(validationError)
              }
              title={canEdit === false ? ADMIN_VIEW_ONLY_ACTION_REASON : undefined}
              onClick={() => void submit(false)}
            >
              {refusal ? "Try all nights again" : "Assign"}
              {nights.length > 0 && !refusal
                ? ` ${nights.length} night${nights.length === 1 ? "" : "s"}`
                : ""}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
