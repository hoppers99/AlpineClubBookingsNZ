"use client";

import { useEffect, useState } from "react";
import { BedDouble } from "lucide-react";
import { Label } from "@/components/ui/label";

interface BedOption {
  bedId: string;
  bedName: string;
  bedType: string;
  roomId: string;
  roomName: string;
  available: boolean;
  allocatedNights: string[];
  custodianHeldNights: string[];
  heldByThisAssignment: boolean;
}

interface RoomGroup {
  roomId: string;
  roomName: string;
  beds: BedOption[];
}

interface CustodianBedPickerProps {
  lodgeId: string | null;
  startDate: string;
  endDate: string;
  /** null = "No bed — role only", the default. */
  value: string | null;
  onChange: (bedId: string | null) => void;
  /** Set when editing an existing assignment, so its own hold is excluded. */
  assignmentId?: string;
  // Tri-state (#2065): `undefined` while the session resolves. `!canEdit`
  // disables, so this must never default to true.
  canEdit: boolean | undefined;
}

/**
 * Optional bed picker for a hut-leader assignment (#2286).
 *
 * Holding a bed turns the assignment into a *custodian occupancy*: that bed
 * leaves the bookable pool for every night the assignment covers, with no
 * booking anywhere. "No bed — role only" is the default and is exactly the
 * behaviour that existed before this feature.
 *
 * Unavailable beds are listed with the nights that block them rather than
 * hidden: an admin who cannot see why a bed is missing has no way to free it.
 */
export function CustodianBedPicker({
  lodgeId,
  startDate,
  endDate,
  value,
  onChange,
  assignmentId,
  canEdit,
}: CustodianBedPickerProps) {
  const [rooms, setRooms] = useState<RoomGroup[] | null>(null);
  const [loading, setLoading] = useState(false);
  // The bed-allocation module being off is not an error — the picker simply
  // does not apply, so the whole section stays out of the way.
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!startDate || !endDate || startDate > endDate) {
      setRooms(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ startDate, endDate });
    if (lodgeId) params.set("lodgeId", lodgeId);
    if (assignmentId) params.set("assignmentId", assignmentId);
    void fetch(`/api/admin/hut-leaders/available-beds?${params.toString()}`)
      .then(async (res) => {
        if (cancelled) return;
        if (res.status === 404) {
          setUnavailable(true);
          setRooms(null);
          return;
        }
        if (!res.ok) {
          setRooms(null);
          return;
        }
        const data = (await res.json()) as { rooms?: RoomGroup[] };
        setUnavailable(false);
        // Never trust the shape: this picker renders inside the assignment form,
        // so a malformed or unexpected response must degrade to "no beds
        // offered" rather than take the whole Hut Leaders page down.
        setRooms(Array.isArray(data?.rooms) ? data.rooms : []);
      })
      .catch(() => {
        if (!cancelled) setRooms(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lodgeId, startDate, endDate, assignmentId]);

  if (unavailable) return null;

  return (
    <div className="space-y-2">
      <Label
        htmlFor="custodian-bed"
        className="flex items-center gap-1.5 text-sm font-semibold text-foreground"
      >
        <BedDouble aria-hidden className="h-4 w-4" />
        Hold a bed (optional)
      </Label>
      <p className="text-xs text-muted-foreground">
        Leave this as &ldquo;No bed&rdquo; for a role-only assignment. Choosing a
        bed takes it out of the bookable pool for{" "}
        <span className="font-medium">every night from {startDate} to {endDate}</span>{" "}
        — including the night of {endDate} itself. If these dates came from the
        automatic assignment (which ends on a guest&rsquo;s <em>departure</em>{" "}
        day), trim the end date by one day first or the bed is held for one night
        longer than anyone is here.
      </p>
      <select
        id="custodian-bed"
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
        value={value ?? ""}
        disabled={!canEdit || loading}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">No bed — role only</option>
        {(rooms ?? []).map((room) => (
          <optgroup key={room.roomId} label={room.roomName}>
            {room.beds.map((bed) => (
              <option
                key={bed.bedId}
                value={bed.bedId}
                disabled={!bed.available && !bed.heldByThisAssignment}
              >
                {bed.bedName}
                {bed.available || bed.heldByThisAssignment
                  ? ""
                  : bed.custodianHeldNights.length > 0
                    ? ` — held by another custodian on ${bed.custodianHeldNights.join(", ")}`
                    : ` — guests allocated on ${bed.allocatedNights.join(", ")}`}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {loading ? (
        <p className="text-xs text-muted-foreground">Checking beds…</p>
      ) : null}
      {rooms !== null && rooms.length === 0 && !loading ? (
        <p className="text-xs text-muted-foreground">
          This lodge has no active beds set up, so there is nothing to hold.
        </p>
      ) : null}
    </div>
  );
}
