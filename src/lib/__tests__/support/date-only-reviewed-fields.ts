/**
 * The reviewed record of which `DateTime` columns actually hold a CALENDAR DAY.
 *
 * Extracted from `date-only-encoding-guard.test.ts` (#2684) by #2860 so that
 * more than one guard can read the SAME list instead of restating it. Two now
 * do, and they cover different halves of the problem:
 *
 * - `src/lib/__tests__/date-only-encoding-guard.test.ts` classifies encoder call
 *   sites by the FIELD NAME written at the site — `formatDateOnly(m.joinedDate)`
 *   — and consults this list to decide whether a bare-`DateTime` read is a
 *   reviewed calendar day or an unreviewed instant truncation.
 * - `src/lib/__tests__/member-merge-field-kinds.test.ts` binds
 *   `MERGE_FIELD_VALUE_KINDS` (`src/lib/member-merge-field-kinds.ts`) to this
 *   list, so the member-merge screen's per-field classification cannot
 *   contradict it.
 *
 * THE SECOND ONE EXISTS BECAUSE THE FIRST STRUCTURALLY CANNOT SEE IT. The
 * scanner resolves a field name out of the ARGUMENT EXPRESSION, so it only
 * classifies a site that names the column. The merge screen renders a generic
 * table of `unknown` values whose field is a runtime string, so no field name
 * appears at the call site, and the guard passes over it in silence — which is
 * exactly the shape of renderer that produced #2860 in the first place. Binding
 * the two lists is what stops that blind spot becoming a second, divergent
 * opinion about what `joinedDate` means.
 */

/**
 * `DateTime` columns that nevertheless hold a DATE-ONLY value, with the write
 * that proves it.
 *
 * The column type is a good first filter and not the last word. These fields
 * were declared `DateTime` without `@db.Date`, but every write is INTENDED to
 * pin them to UTC midnight from a `yyyy-MM-dd` string, so they are calendar days
 * living in an un-annotated column — `formatDateOnly` reads back exactly the day
 * that was stored. Sending them through the club-timezone helper instead would
 * agree on every correctly-pinned row and quietly DISAGREE on a corrupt one,
 * which is the wrong way round for a value whose meaning is a plain date.
 *
 * "INTENDED" is doing real work in that sentence, and #2860 found out why: this
 * list records what a field MEANS, which is not a promise that every writer
 * honours it. `parseXeroCompanyNumberDate` builds SERVER-LOCAL midnight for a
 * Xero-imported `dateOfBirth` (**#2859**, open), so some stored rows are a day
 * early. That does not move `dateOfBirth` off this list — a birthday is still a
 * calendar day and truncation still reads back the day that was stored — but a
 * reader must not infer from an entry here that the stored data is clean.
 *
 * The honest fix is to annotate the columns `@db.Date`, which is a migration and
 * a data audit rather than a lint pass; until then this list is the record of
 * which ones were checked.
 */
export const DATE_ONLY_IN_DATETIME_COLUMN: Record<string, string> = {
  dateOfBirth:
    "Member.dateOfBirth — written via parseDateOnly() on the profile route and new Date('yyyy-mm-dd') on the admin/import paths; a birthday is a calendar day, never an instant. The Xero import writes server-local midnight instead (#2859, open), so the MEANING holds while some stored rows do not",
  requestedDateOfBirth:
    "FamilyGroupJoinRequest.requestedDateOfBirth — the same date-of-birth value carried through the join request",
  childDateOfBirth:
    "FamilyGroupJoinRequest.childDateOfBirth — as above, for the child on a family join request",
  applicantDateOfBirth:
    "MemberApplication.applicantDateOfBirth — the date of birth captured on the membership application",
  joinedDate:
    "Member.joinedDate — the membership START DATE, written from a date string on the admin/import paths and from the Xero first-invoice date on the sync",
  lifeMemberDate:
    "Member.lifeMemberDate — the calendar day life membership was granted",
  validFrom:
    "PromoCode.validFrom — written via parseDateOnly() from a `dateOnlyString` schema; a promo window edge is a calendar day",
  validUntil: "PromoCode.validUntil — same window, same write",
  bookingStartFrom:
    "PromoCode.bookingStartFrom — gates on the booking's CHECK-IN, itself a `@db.Date` lodge night",
  bookingStartUntil: "PromoCode.bookingStartUntil — same gate, same write",
};
