/**
 * Shared, PURE contract for the B5 (#2262) manual mark-paid REVERSAL
 * BookingEvent.
 *
 * Reversing a manual cash settlement is not a cancellation — the booking is
 * still live, it is simply back to being unpaid — but BookingEventType has no
 * neutral member for "the settlement was un-recorded", and a durable,
 * never-pruned history entry is mandatory for a money-state change.
 *
 * So the reversal is recorded as a CANCELLED BookingEvent carrying this
 * discriminator in its `snapshot`, exactly as #2008 did for the duplicate-capture
 * auto-refund, and every consumer that pattern-matches CANCELLED events (today:
 * the shared member/admin narrative, which reads the FIRST CANCELLED event as
 * "when this booking was cancelled") MUST exclude it via
 * `isManualSettlementReversalEvent`. Without that exclusion a booking that is
 * reversed and LATER genuinely cancelled would show the member the reversal's
 * date as its cancellation date.
 *
 * This module is intentionally free of the database client and logger so the
 * pure narrative resolver can import the predicate without pulling
 * `@/lib/prisma` into its bundle. It depends only on the `@prisma/client` enum,
 * which the narrative already imports.
 */
import { BookingEventType } from "@prisma/client";

/** Snapshot discriminator marking a CANCELLED event as a #2262 manual reversal. */
export const MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND =
  "manual_mark_paid_reversed" as const;

/**
 * Honest, member-neutral copy stored on the event's `reason`. Rendered on the
 * admin booking-history timeline; never enters the member/guest narrative.
 */
export const MANUAL_SETTLEMENT_REVERSAL_EVENT_REASON =
  "Manually recorded payment reversed — the booking is unpaid again and was not cancelled.";

/** Frozen facts stored on the reversal BookingEvent snapshot. */
export interface ManualSettlementReversalEventSnapshot {
  kind: typeof MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND;
  /** The booking status stored at settle time, before the DRAFT coercion. */
  storedPreviousStatus: string;
  /** The status the booking was actually restored to. */
  restoredStatus: string;
  /** Recovery operations this reversal terminally closed (HIGH #1). */
  closedRecoveryOperationIds: string[];
  /** Whether a restored CONFIRMED internet-banking hold deadline was cleared. */
  clearedInternetBankingHold: boolean;
  /** The acting admin's free-text note, when one was given. */
  note: string | null;
}

/**
 * Narrow an arbitrary event snapshot to a manual-reversal snapshot, or null
 * when it is not one.
 */
export function asManualSettlementReversalSnapshot(
  value: unknown
): ManualSettlementReversalEventSnapshot | null {
  if (
    value &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind ===
      MANUAL_SETTLEMENT_REVERSAL_EVENT_KIND
  ) {
    return value as ManualSettlementReversalEventSnapshot;
  }
  return null;
}

/**
 * True when a durable event is a #2262 manual mark-paid reversal: a CANCELLED
 * event carrying the discriminator snapshot. The booking narrative excludes
 * these so a reversal is never misread as the booking's cancellation.
 */
export function isManualSettlementReversalEvent(event: {
  type: BookingEventType;
  snapshot: unknown;
}): boolean {
  return (
    event.type === BookingEventType.CANCELLED &&
    asManualSettlementReversalSnapshot(event.snapshot) !== null
  );
}
