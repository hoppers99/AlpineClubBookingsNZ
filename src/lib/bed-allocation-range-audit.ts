/**
 * The audit record a range assignment leaves (#2251 residual R4, extracted
 * #2688).
 *
 * Written INSIDE the caller's transaction, so the rows and the record of them
 * commit or roll back together. Its own module because what the trail records
 * — and, for privacy, what it deliberately does not — is a separate concern
 * from deciding which nights may be written.
 */
import { formatDateOnly } from "@/lib/date-only";
import { createAuditLog } from "@/lib/audit";
import type { BedAllocationDb } from "@/lib/bed-allocation-admin-contract";
import {
  summariseNightRuns,
  type AssignBedRangeResult,
  type BedRangeRefusalCategory,
} from "@/lib/bed-allocation-range-report";

/**
 * Cap on how many partner promotions the range path's ONE batched
 * `BED_ALLOCATION_PARTNERS_PROMOTED` entry lists verbatim (#2251 residual R4).
 *
 * Pinned, like `MAX_AUDITED_PRUNED_ALLOCATIONS` in `bed-allocation-lifecycle.ts`,
 * to the audit layer's own `MAX_METADATA_ARRAY_ITEMS` (`src/lib/audit.ts`): the
 * sanitiser silently truncates any metadata array past 50 entries and replaces
 * the WHOLE blob with a short preview once the serialised JSON passes its size
 * budget, so listing more would not preserve them and could cost the entries that
 * DO fit. The exact figure is always recorded alongside as `promotedCount`, and
 * `promotionsTruncated` says the list is partial.
 */
export const MAX_AUDITED_RANGE_PARTNER_PROMOTIONS = 50;

/**
 * How many DISTINCT promoted-partner booking ids the batched entry repeats into
 * its searchable `details` string (#2251 residual R4, review follow-up).
 *
 * The admin audit search matches `action, summary, details, requestId, entityId,
 * targetId` and never metadata (`src/lib/audit-admin-query.ts`), and a booking
 * page's audit link is `?q=<bookingId>`. One batched entry has only one
 * `targetId` — the booking whose range assignment caused the promotions — so
 * without this the promoted partner's OWN booking could no longer find the entry
 * that explains why its guest became a primary. 30 × a 25-character cuid plus the
 * prefix stays inside `sanitizeMetadataString`'s 1000-character budget
 * (`src/lib/audit.ts`), so the string is never truncated mid-id; a longer list
 * (many different bookings' partners stranded by one range) states the overflow
 * and leaves the full set in `metadata.promotions`.
 */
const MAX_SEARCHABLE_PROMOTED_BOOKING_IDS = 30;

/**
 * Record the range operation and hand the result back — INSIDE the caller's
 * transaction (#2251 review A4/C5/B4).
 *
 * The audit write used to sit in the route, AFTER the transaction committed. A
 * failure there (or a crash between the two) left rows on real beds with no
 * record of who put them there, and answered the admin with a 500 for an
 * assignment that had in fact happened. Written here, rows and record commit or
 * roll back together.
 *
 * The entry describes an attempt that COMPLETED, either way: `applied` true, or
 * a refusal with its report. Attempts that THROW — unknown guest/bed, cancelled
 * booking, deactivated bed, an over-cap range, a lost write race — roll the
 * transaction back and deliberately record nothing, because nothing happened.
 *
 * Privacy (#2251 review C6): the metadata records SHAPE, not people. Up to 366
 * refusals, each naming another booking's guest and member, would file a roster
 * of unrelated members into an admin audit row that long outlives the board.
 * Counts, the refused night runs per category and the involved booking ids are
 * what an auditor needs; the names go to the admin who asked, in the API
 * response, and nowhere else. This matches the sibling BED_ALLOCATION_BULK_SET
 * entry, which records `{stayDate, reason}` conflicts and no names.
 */
export async function recordRangeAssignAudit(
  db: BedAllocationDb,
  actorMemberId: string,
  result: AssignBedRangeResult,
): Promise<AssignBedRangeResult> {
  const refusedNights: Record<BedRangeRefusalCategory, string[]> = {
    EXCLUSIVE_HOLD: [],
    GUEST_NOT_BOOKED: [],
    CUSTODIAN_HOLD: [],
    BED_TAKEN: [],
  };
  const involvedBookingIds = new Set<string>();
  for (const refusal of result.refusals) {
    refusedNights[refusal.category].push(refusal.stayDate);
    if (refusal.occupiedBy) involvedBookingIds.add(refusal.occupiedBy.bookingId);
    if (refusal.hold) involvedBookingIds.add(refusal.hold.bookingId);
  }

  /*
   * ONE audit entry for the whole operation, whichever way it went (owner
   * decision, 26 Jul 2026) — including the "assign the nights I chose" path,
   * which is one deliberate action and should read as one. A refused attempt is
   * recorded too, with outcome "failure": someone tried, and the trail should
   * say so and say why.
   *
   * targetId is the BOOKING id so the booking page's "Audit log" deep link
   * (?q=<bookingId>, which matches targetId and never metadata) surfaces range
   * operations — required by #2252, which drives this same path from inside a
   * booking.
   */
  await createAuditLog(
    {
      action: "BED_ALLOCATION_RANGE_SET",
      memberId: actorMemberId,
      targetId: result.bookingId,
      entityType: "BedAllocation",
      category: "lodge",
      outcome: result.applied ? "success" : "failure",
      summary: result.applied
        ? `Bed assigned across ${result.writtenNights.length} night${result.writtenNights.length === 1 ? "" : "s"}${result.partialByConsent ? " (a subset the admin chose)" : ""}`
        : "Range bed assignment refused — nothing written",
      metadata: {
        bookingGuestId: result.bookingGuestId,
        bedId: result.bedId,
        bedName: result.bedName,
        roomName: result.roomName,
        requestedFrom: result.fromDate,
        requestedTo: result.toDate,
        requestedNightCount: result.requestedNights.length,
        // Auto-approved (#2251 decision 4): these rows land approved, which is
        // what locks the member's requested-room editing for this booking.
        autoApproved: result.applied,
        partialByConsent: result.partialByConsent,
        writtenNightCount: result.writtenNights.length,
        writtenNightRuns: summariseNightRuns(result.writtenNights),
        refusedNightCount: result.refusals.length,
        refusedNightCountsByCategory: {
          EXCLUSIVE_HOLD: refusedNights.EXCLUSIVE_HOLD.length,
          GUEST_NOT_BOOKED: refusedNights.GUEST_NOT_BOOKED.length,
          CUSTODIAN_HOLD: refusedNights.CUSTODIAN_HOLD.length,
          BED_TAKEN: refusedNights.BED_TAKEN.length,
        },
        refusedNightRunsByCategory: {
          EXCLUSIVE_HOLD: summariseNightRuns(refusedNights.EXCLUSIVE_HOLD),
          GUEST_NOT_BOOKED: summariseNightRuns(refusedNights.GUEST_NOT_BOOKED),
          CUSTODIAN_HOLD: summariseNightRuns(refusedNights.CUSTODIAN_HOLD),
          BED_TAKEN: summariseNightRuns(refusedNights.BED_TAKEN),
        },
        involvedBookingIds: [...involvedBookingIds],
      },
    },
    db,
  );

  /*
   * Moving a shared double's primary onto another bed auto-promotes the partner
   * left on the OLD bed-night (#1750). On the range path this is recorded as ONE
   * batched entry, not one per promotion (#2251 residual R4): a 366-night move
   * off shared doubles would otherwise write up to 366 audit rows inside the
   * transaction, so the one thing left growing with the range length is now
   * bounded too — every statement AND every audit row in this transaction is
   * fixed whatever the night count.
   *
   * The single-night and bulk board paths keep their per-promotion
   * BED_ALLOCATION_PARTNER_PROMOTED entries: they vacate one bed-night, so there
   * is nothing to batch and the established shape stays untouched.
   *
   * Shape follows the #2285 prune precedent (MAX_AUDITED_PRUNED_ALLOCATIONS): a
   * compact list capped at the audit sanitiser's array limit, the exact count
   * alongside it, and a flag saying the list is partial. `targetId` is the
   * booking whose range assignment caused the promotions — a promoted partner may
   * belong to a DIFFERENT booking, so each entry in the list carries its own
   * `bookingId`/`bookingGuestId` rather than the trail implying it was this
   * booking's row that moved.
   *
   * SEARCHABILITY (review finding on the batching): the admin audit search ORs
   * over `action, summary, details, requestId, entityId, targetId` and never
   * metadata (`audit-admin-query.ts`), and the booking page's audit link is
   * `?q=<bookingId>`. One batched entry can only carry ONE `targetId`, so the
   * promoted partner's own booking would stop being findable from its own
   * booking page — exactly the property the range entry above relies on. The
   * distinct promoted booking ids are therefore also written into `details`,
   * which IS searched, capped so the string stays inside the audit layer's
   * per-string budget with the overflow stated rather than silently dropped.
   */
  if (result.promotedPartners.length > 0) {
    const promotedBookingIds = [
      ...new Set(result.promotedPartners.map((row) => row.bookingId)),
    ];
    const searchableBookingIds = promotedBookingIds.slice(
      0,
      MAX_SEARCHABLE_PROMOTED_BOOKING_IDS,
    );
    const overflow = promotedBookingIds.length - searchableBookingIds.length;
    await createAuditLog(
      {
        action: "BED_ALLOCATION_PARTNERS_PROMOTED",
        memberId: actorMemberId,
        targetId: result.bookingId,
        entityType: "BedAllocation",
        category: "lodge",
        outcome: "success",
        summary: `${result.promotedPartners.length} second occupant${result.promotedPartners.length === 1 ? "" : "s"} auto-promoted to primary after a range assignment moved the shared double's primary to another bed`,
        details: `Promoted partner bookings: ${searchableBookingIds.join(", ")}${overflow > 0 ? ` (+${overflow} more in metadata.promotions)` : ""}`,
        metadata: {
          issue: 1750,
          // The guest whose range assignment vacated the bed-nights, named
          // distinctly from each promoted partner's own bookingGuestId below:
          // they are different people on possibly different bookings.
          movedBookingGuestId: result.bookingGuestId,
          movedToBedId: result.bedId,
          promotedCount: result.promotedPartners.length,
          promotions: result.promotedPartners
            .slice(0, MAX_AUDITED_RANGE_PARTNER_PROMOTIONS)
            .map((promotedPartner) => ({
              allocationId: promotedPartner.id,
              bookingId: promotedPartner.bookingId,
              bookingGuestId: promotedPartner.bookingGuestId,
              bedId: promotedPartner.bedId,
              stayDate: formatDateOnly(promotedPartner.stayDate),
            })),
          promotionsTruncated:
            result.promotedPartners.length >
            MAX_AUDITED_RANGE_PARTNER_PROMOTIONS,
        },
      },
      db,
    );
  }

  return result;
}
