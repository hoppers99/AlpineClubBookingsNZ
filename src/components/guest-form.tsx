"use client";

import type { AgeTier } from "@prisma/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAgeTierOptions } from "@/lib/use-age-tier-options";
import { GuestNightGrid } from "@/components/guest-night-grid";

export interface GuestData {
  firstName: string;
  lastName: string;
  ageTier: AgeTier;
  isMember: boolean;
  memberId?: string;
  stayStart?: string;
  stayEnd?: string;
  // Explicit included nights as `yyyy-mm-dd` keys (issue #713). Present only in
  // "Multiple date ranges" mode; undefined means the guest stays the whole
  // booking range.
  nights?: string[];
  /**
   * DISPLAY ONLY, and never sent to the server or trusted for anything
   * ("+ Add Member Guest", epic #2305, MG3 #2308).
   *
   * Set when the booker adds a cross-family member through the finder, so the
   * wizard can show them what WILL happen when they confirm: the club asks the
   * person first (`"PENDING"`), or tells them (`"NOTIFY_ONLY"`). Nothing has
   * been persisted at this point — the booking does not exist yet — so this is a
   * prediction derived from the club's own `approvalRequired` setting, not a
   * consent record.
   *
   * `buildGuestPayload` picks the fields it sends field by field, so this never
   * reaches an API; and were it forged it would change nothing, because every
   * consent column is written server-side by
   * `buildMemberGuestConsentWrite`.
   */
  memberGuestConsentPreview?: "PENDING" | "NOTIFY_ONLY";
}

interface GuestFormProps {
  guests: GuestData[];
  onGuestsChange: (guests: GuestData[]) => void;
  maxGuests: number;
  bookingCheckIn?: string;
  bookingCheckOut?: string;
  perGuestDatesEnabled?: boolean;
  onPerGuestDatesEnabledChange?: (enabled: boolean) => void;
  // Multiple date ranges / per-guest night grid (issue #713).
  multiDateRangesEnabled?: boolean;
  onMultiDateRangesEnabledChange?: (enabled: boolean) => void;
  // Optional nightly price (cents) for a guest on a night, from the live quote.
  nightlyPriceForGuest?: (guestIndex: number, nightKey: string) => number | null;
  /**
   * Extra controls for the "Guests (n/max)" header row, rendered BEFORE the
   * "+ Add Non-Member Guest" button (MG3 #2308: "+ Add Member Guest" sits first,
   * because a member guest is the cheaper, better-recorded outcome and should be
   * the one that catches the eye).
   */
  headerActions?: React.ReactNode;
  /** Rendered immediately under the header row — MG3's inline find panel. */
  belowHeader?: React.ReactNode;
  /** Optional per-guest badge (MG3's consent states), rendered in the guest row header. */
  renderGuestBadge?: (guest: GuestData, index: number) => React.ReactNode;
  /**
   * Optional replacement for the one explanatory sentence under a guest row.
   *
   * The default sentence for a member-linked row says "Linked family members
   * keep their member details and member pricing" — true for every such row
   * until MG3, and false for the cross-family people the finder now adds
   * (#2308). Returning a string replaces it; returning null keeps the default,
   * which is what every existing caller gets by passing nothing at all.
   */
  renderGuestHelper?: (guest: GuestData, index: number) => string | null;
}

function shiftDateOnly(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

/** All night keys (yyyy-mm-dd) from checkIn (inclusive) to checkOut (exclusive). */
function eachNightKey(checkIn: string, checkOut: string): string[] {
  const keys: string[] = [];
  let current = checkIn;
  // Guard against a malformed range producing an infinite loop.
  for (let i = 0; current < checkOut && i < 1000; i++) {
    keys.push(current);
    current = shiftDateOnly(current, 1);
  }
  return keys;
}

export function GuestForm({
  guests,
  onGuestsChange,
  maxGuests,
  bookingCheckIn,
  bookingCheckOut,
  perGuestDatesEnabled = false,
  onPerGuestDatesEnabledChange,
  multiDateRangesEnabled = false,
  onMultiDateRangesEnabledChange,
  nightlyPriceForGuest,
  headerActions,
  belowHeader,
  renderGuestBadge,
  renderGuestHelper,
}: GuestFormProps) {
  const ageTierOptions = useAgeTierOptions();
  const showPerGuestDatesToggle = Boolean(
    bookingCheckIn &&
    bookingCheckOut &&
    guests.length > 1 &&
    onPerGuestDatesEnabledChange &&
    !multiDateRangesEnabled
  );
  const showMultiDateRangesToggle = Boolean(
    bookingCheckIn &&
    bookingCheckOut &&
    guests.length >= 1 &&
    onMultiDateRangesEnabledChange
  );
  const gridNights =
    multiDateRangesEnabled && bookingCheckIn && bookingCheckOut
      ? eachNightKey(bookingCheckIn, bookingCheckOut)
      : [];
  const latestStayStart = bookingCheckOut ? shiftDateOnly(bookingCheckOut, -1) : undefined;

  // In the grid, an undefined `nights` means the guest stays every night.
  function isNightOn(guestIndex: number, nightKey: string): boolean {
    const guestNights = guests[guestIndex]?.nights;
    return guestNights ? guestNights.includes(nightKey) : true;
  }

  function toggleGuestNight(guestIndex: number, nightKey: string) {
    const current = guests[guestIndex]?.nights ?? gridNights;
    const next = current.includes(nightKey)
      ? current.filter((key) => key !== nightKey)
      : [...current, nightKey].sort();
    // A guest must stay at least one night; ignore turning off the last one.
    if (next.length === 0) return;
    onGuestsChange(
      guests.map((g, i) => (i === guestIndex ? { ...g, nights: next } : g)),
    );
  }

  function handleMultiDateRangesChange(enabled: boolean) {
    onMultiDateRangesEnabledChange?.(enabled);
  }

  function addGuest() {
    if (guests.length >= maxGuests) return;
    onGuestsChange([
      ...guests,
      { firstName: "", lastName: "", ageTier: "ADULT", isMember: false },
    ]);
  }

  function removeGuest(index: number) {
    onGuestsChange(guests.filter((_, i) => i !== index));
  }

  function updateGuest(index: number, field: keyof GuestData, value: string | boolean) {
    const updated = guests.map((g, i) => {
      if (i !== index) return g;
      return { ...g, [field]: value };
    });
    onGuestsChange(updated);
  }

  function handlePerGuestDatesChange(enabled: boolean) {
    onPerGuestDatesEnabledChange?.(enabled);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg font-semibold">
          Guests ({guests.length}/{maxGuests} max)
        </h3>
        <div className="flex flex-wrap gap-2">
          {headerActions}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={addGuest}
            disabled={guests.length >= maxGuests}
          >
            + Add Non-Member Guest
          </Button>
        </div>
      </div>

      {belowHeader}

      {guests.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Add at least one guest to proceed. You should include yourself if you&apos;re staying.
        </p>
      )}

      {showPerGuestDatesToggle && (
        <div className="flex items-center gap-2 rounded-md border p-3">
          <Checkbox
            id="per-guest-booking-dates"
            checked={perGuestDatesEnabled}
            onCheckedChange={(checked) => handlePerGuestDatesChange(checked === true)}
          />
          <Label htmlFor="per-guest-booking-dates" className="cursor-pointer">
            Per guest booking dates
          </Label>
        </div>
      )}

      {showMultiDateRangesToggle && (
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Checkbox
              id="multiple-date-ranges"
              checked={multiDateRangesEnabled}
              onCheckedChange={(checked) => handleMultiDateRangesChange(checked === true)}
            />
            <Label htmlFor="multiple-date-ranges" className="cursor-pointer">
              Multiple date ranges
            </Label>
          </div>
          {multiDateRangesEnabled && (
            <GuestNightGrid
              guestLabels={guests.map((g, i) =>
                `${g.firstName} ${g.lastName}`.trim() || `Guest ${i + 1}`,
              )}
              nights={gridNights}
              isNightOn={isNightOn}
              priceForNight={nightlyPriceForGuest}
              onToggle={toggleGuestNight}
              arrivalLabel={bookingCheckIn}
              departureLabel={bookingCheckOut}
            />
          )}
        </div>
      )}

      {guests.map((guest, index) => {
        const isLinkedMember = Boolean(guest.memberId);
        const stayStart = guest.stayStart || bookingCheckIn || "";
        const stayEnd = guest.stayEnd || bookingCheckOut || "";
        const earliestStayEnd = stayStart ? shiftDateOnly(stayStart, 1) : bookingCheckIn;
        return (
          <div key={index} className="rounded-lg border p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">Guest {index + 1}</span>
            {renderGuestBadge?.(guest, index)}
            <span className="flex-1" />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeGuest(index)}
              className="text-danger-11 hover:text-danger-11"
            >
              Remove
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>First Name</Label>
              <Input
                value={guest.firstName}
                onChange={(e) => updateGuest(index, "firstName", e.target.value)}
                placeholder="First name"
                required
                disabled={isLinkedMember}
              />
            </div>
            <div className="space-y-1">
              <Label>Last Name</Label>
              <Input
                value={guest.lastName}
                onChange={(e) => updateGuest(index, "lastName", e.target.value)}
                placeholder="Last name"
                required
                disabled={isLinkedMember}
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label>Age Category</Label>
            <select
              value={guest.ageTier}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) => updateGuest(index, "ageTier", e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isLinkedMember}
            >
              {ageTierOptions.map((option) => (
                <option key={option.tier} value={option.tier}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <p className="text-sm text-muted-foreground">
            {renderGuestHelper?.(guest, index) ??
              (isLinkedMember
                ? "Linked family members keep their member details and member pricing."
                : "Typed-in guests are treated as non-members and charged at non-member rates.")}
          </p>
          {perGuestDatesEnabled && !multiDateRangesEnabled && bookingCheckIn && bookingCheckOut && (
            <div className="grid grid-cols-1 gap-3 border-t pt-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor={`guest-${index}-stay-start`}>Date In</Label>
                <Input
                  id={`guest-${index}-stay-start`}
                  type="date"
                  value={stayStart}
                  min={bookingCheckIn}
                  max={latestStayStart}
                  onChange={(e) => updateGuest(index, "stayStart", e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor={`guest-${index}-stay-end`}>Date Out</Label>
                <Input
                  id={`guest-${index}-stay-end`}
                  type="date"
                  value={stayEnd}
                  min={earliestStayEnd}
                  max={bookingCheckOut}
                  onChange={(e) => updateGuest(index, "stayEnd", e.target.value)}
                  required
                />
              </div>
            </div>
          )}
          </div>
        );
      })}
    </div>
  );
}
