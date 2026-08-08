"use client";

import { useEffect, useId, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

interface RoomOption {
  id: string;
  name: string;
  bedCount: number;
}

interface RequestedRoom {
  id: string;
  name: string;
  active: boolean;
}

interface RequestedRoomEditorProps {
  bookingId: string;
  initialRoom: RequestedRoom | null;
  canEdit: boolean;
  /**
   * API base path for the save/clear calls. Defaults to the admin route so
   * existing admin usage is unchanged; members pass the member route
   * (`/api/bookings/[id]/requested-room`). Issue #776.
   */
  endpoint?: string;
  /**
   * Read-only explanation shown when editing is locked (e.g. the lodge has
   * confirmed the bed allocation). Only rendered when `canEdit` is false.
   */
  lockedNote?: string;
}

/** What the requested-room routes return on a successful write. */
interface RequestedRoomWriteResult {
  requestedRoom: RequestedRoom | null;
}

function selectionValue(room: RequestedRoom | null): string {
  return room?.id ?? "none";
}

/**
 * What to show while the write is in flight. The picker offers active rooms
 * plus, when the booking already holds one, the inactive room it holds — which
 * is not in `roomOptions`, so fall back to what is already known about it.
 */
function optimisticRoom(
  value: string,
  roomOptions: RoomOption[],
  current: RequestedRoom | null,
): RequestedRoom | null {
  if (value === "none") return null;
  const selected = roomOptions.find((option) => option.id === value);
  if (selected) return { id: selected.id, name: selected.name, active: true };
  return current?.id === value ? current : null;
}

export function RequestedRoomEditor({
  bookingId,
  initialRoom,
  canEdit,
  endpoint,
  lockedNote,
}: RequestedRoomEditorProps) {
  const basePath =
    endpoint ?? `/api/admin/bookings/${bookingId}/requested-room`;
  // `savedRoom` is what the SERVER holds. `room` is what is on screen. They
  // only diverge while a save is in flight, so a refusal can put the control
  // back to the room that is actually stored instead of leaving a rejected
  // choice sitting there looking accepted.
  const [savedRoom, setSavedRoom] = useState(initialRoom);
  const [room, setRoom] = useState(initialRoom);
  const [roomOptions, setRoomOptions] = useState<RoomOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const statusId = useId();

  useEffect(() => {
    if (!canEdit) return;
    fetch("/api/bookings/rooms")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setRoomOptions(data?.rooms ?? []))
      .catch(() => setRoomOptions([]));
  }, [canEdit]);

  async function handleChange(value: string) {
    // #2143 dirty gate. Re-picking the room that is already stored is not a
    // change, and a pristine editor must never fire a write — every one of
    // these is an audited booking mutation on the server.
    if (value === selectionValue(savedRoom)) {
      setRoom(savedRoom);
      setError(null);
      return;
    }

    const optimistic = optimisticRoom(value, roomOptions, savedRoom);

    setRoom(optimistic);
    setSaving(true);
    setSaved(false);
    setError(null);

    try {
      /*
        #2654. This used to `await fetch(...)` and then show "Saved"
        unconditionally. `fetch` rejects only on a network failure, so a 400
        from the room validator, a 403 from the ownership check or the 409 the
        writer raises when the lodge has already allocated the beds all
        resolved normally — and the member was told their room request was
        stored when the server had refused it. Check the response, and say what
        actually happened.
      */
      const response = await (value === "none"
        ? fetch(basePath, { method: "DELETE" })
        : fetch(basePath, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestedRoomId: value }),
          }));

      if (!response.ok) {
        // Prefer the server's own words. It is the one that knows whether this
        // was an unknown room, a room in another lodge, a cancelled booking, a
        // booking whose beds are already allocated, or a missing permission.
        let message =
          "Could not save your room request. Please try again.";
        try {
          const body: unknown = await response.json();
          if (
            body &&
            typeof body === "object" &&
            "error" in body &&
            typeof (body as { error?: unknown }).error === "string"
          ) {
            message = (body as { error: string }).error;
          }
        } catch {
          // A non-JSON error body is not worth surfacing raw; keep the default.
        }
        setRoom(savedRoom);
        setError(message);
        return;
      }

      // Take the stored room from the response rather than from the option we
      // sent, so an inactive room the server kept is shown as inactive.
      let confirmed = optimistic;
      try {
        const body = (await response.json()) as RequestedRoomWriteResult | null;
        if (body && typeof body === "object" && "requestedRoom" in body) {
          confirmed = body.requestedRoom ?? null;
        }
      } catch {
        // Keep the optimistic value; the write itself succeeded.
      }
      setRoom(confirmed);
      setSavedRoom(confirmed);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // Network failure: nothing reached the server, so the stored room stands.
      setRoom(savedRoom);
      setError("Could not reach the server. Your room request was not saved.");
    } finally {
      setSaving(false);
    }
  }

  const inactiveChip = room && !room.active ? (
    <Badge variant="outline" className="border-warning-6 bg-warning-3 text-warning-11">
      Room no longer active &mdash; treated as no preference
    </Badge>
  ) : null;

  if (!canEdit) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <p className="text-sm text-muted-foreground">{room ? room.name : "No preference"}</p>
          {inactiveChip}
        </div>
        {lockedNote ? (
          <p className="text-sm text-muted-foreground">{lockedNote}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <div className="w-64">
          <Select value={selectionValue(room)} onValueChange={handleChange} disabled={saving}>
            <SelectTrigger
              aria-label="Preferred room"
              aria-describedby={error ? statusId : undefined}
            >
              <SelectValue placeholder="No preference" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No preference</SelectItem>
              {room && !room.active && (
                <SelectItem value={room.id}>{room.name} (inactive)</SelectItem>
              )}
              {roomOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name} ({option.bedCount} {option.bedCount === 1 ? "bed" : "beds"})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {inactiveChip}
        {saving && <span className="text-xs text-muted-foreground">Saving...</span>}
        {saved && <span className="text-xs text-success-11">Saved</span>}
      </div>
      {/*
        `role="status"` rather than `role="alert"`: this is the outcome of the
        member's own action on the control they just used, so it is announced
        without stealing focus from it. Matches the arrival-time editor.
      */}
      {error && (
        <p id={statusId} role="status" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
