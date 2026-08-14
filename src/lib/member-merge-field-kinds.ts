import { APP_TIME_ZONE } from "@/config/operational";
import { formatDateOnly, formatDateOnlyForTimeZone } from "@/lib/date-only";

/**
 * What a member-merge comparison value MEANS, declared per field (#2860).
 *
 * The merge screen renders every field of two member records side by side so a
 * Full Admin can decide which record survives an IRREVERSIBLE merge. It used to
 * format each value by looking at its runtime type:
 *
 * ```ts
 * if (value instanceof Date) return value.toISOString().slice(0, 10);
 * if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
 * ```
 *
 * Both arms are a UTC truncation, and a runtime type cannot tell the two kinds
 * of date apart — which is the whole defect, not an implementation detail of it:
 *
 * - `photoUpdatedAt` and `hutLeaderEligibleAt` are real INSTANTS (`new Date()`
 *   at the moment of the event). New Zealand runs 12-13 hours ahead of UTC, so
 *   truncating one to its UTC day dated it to the PREVIOUS day for roughly the
 *   first half of every club day — on the screen whose whole purpose is to let a
 *   human judge which record is more recent, where `photoUpdatedAt` is a recency
 *   signal by construction (`INV-DATE-019`).
 * - `dateOfBirth`, `joinedDate` and `lifeMemberDate` are CALENDAR DAYS pinned to
 *   UTC midnight by their writers, and for those the same truncation is exactly
 *   right (`INV-DATE-010`). Reading one through the club-zone formatter would
 *   happen to agree in New Zealand — UTC midnight is midday NZ, still the same
 *   day — and be wrong by a day for any club sitting behind UTC.
 *
 * So the kind is declared here, once, next to the evidence for it, and the
 * renderer is told which one it holds. The classification below is proved from
 * `prisma/schema.prisma` plus every write path, never from the field name.
 *
 * NONE of the merged Member date columns is `@db.Date` — they are all bare
 * `DateTime?`. The column type therefore settles nothing on this screen and the
 * writers are what decide, which is why each row below cites one.
 */
export type MergeFieldValueKind = "calendarDay" | "instant" | "plain";

/**
 * Every field `mergeMemberFields` emits, with its kind and the evidence.
 *
 * `src/lib/__tests__/member-merge-field-kinds.test.ts` pins this map to that
 * function's actual output in both directions: a merged field with no declared
 * kind fails, and a declared kind for a field no longer merged fails too.
 */
export const MERGE_FIELD_VALUE_KINDS: Readonly<
  Record<string, MergeFieldValueKind>
> = {
  // --- FILL_IF_BLANK_FIELDS ------------------------------------------------
  title: "plain", // `Title?` enum (schema.prisma:510)
  gender: "plain", // `Gender?` enum (schema.prisma:513)
  // `DateTime?` (schema.prisma:514) but a calendar day in every writer: the
  // admin services validate `^\d{4}-\d{2}-\d{2}$` and hand it to `new Date`,
  // which is UTC midnight (admin-member-detail-service.ts:1197,
  // admin-members-service.ts:1432); the member-facing routes call
  // `parseDateOnly` (api/profile/route.ts:241, api/members/family/*); the CSV
  // importer normalises to `yyyy-MM-dd` and calls `parseDateOnly`
  // (api/admin/members/import/route.ts:209). #2859 says it plainly: "a date of
  // birth is a calendar day, never an instant".
  //
  // The one writer that disagrees is `parseXeroCompanyNumberDate`
  // (xero-contacts.ts:364), which builds SERVER-LOCAL midnight and so stores a
  // Xero-imported DOB a day early. That is a STORAGE defect on a calendar-day
  // field (#2859, still open), not a second meaning: this screen keeps showing
  // what is stored, and #2859 fixes what is stored.
  dateOfBirth: "calendarDay",
  occupation: "plain", // `String?` (schema.prisma:517)
  // `DateTime?` (schema.prisma:573). Same calendar-day writers as `joinedDate`:
  // `^\d{4}-\d{2}-\d{2}$` -> `new Date` (admin-members-service.ts:1465,
  // admin-member-detail-service.ts:1173) and `parseDateOnly` on import. It is
  // never stamped from a clock, and no other writer exists in src/, scripts/ or
  // prisma/. (#2860's issue body called this one an instant; the writers say
  // otherwise, so it is classified as what its writers store.)
  lifeMemberDate: "calendarDay",
  comments: "plain", // `String? @db.Text` (schema.prisma:580)
  familyGroupId: "plain", // `String?` FK (schema.prisma:630)

  // --- GROUP_FILL_SPECS: phone ---------------------------------------------
  phoneCountryCode: "plain", // `String?` (schema.prisma:530)
  phoneAreaCode: "plain", // `String?` (schema.prisma:531)
  phoneNumber: "plain", // `String?` (schema.prisma:532)

  // --- GROUP_FILL_SPECS: photo ---------------------------------------------
  photoImageId: "plain", // `String?` FK (schema.prisma:525)
  // `DateTime?` (schema.prisma:526), stamped `now` when a photo is stored or
  // replaced (api/members/[id]/photo/route.ts:410,517). A true instant.
  photoUpdatedAt: "instant",
  photoUpdatedByMemberId: "plain", // `String?` audit snapshot (schema.prisma:527)

  // --- GROUP_FILL_SPECS: street address ------------------------------------
  streetAddressLine1: "plain", // `String?` (schema.prisma:540)
  streetAddressLine2: "plain", // `String?` (schema.prisma:541)
  streetCity: "plain", // `String?` (schema.prisma:542)
  streetRegion: "plain", // `String?` (schema.prisma:543)
  streetPostalCode: "plain", // `String?` (schema.prisma:544)
  streetCountry: "plain", // `String?` (schema.prisma:545)

  // --- GROUP_FILL_SPECS: postal address ------------------------------------
  postalAddressLine1: "plain", // `String?` (schema.prisma:548)
  postalAddressLine2: "plain", // `String?` (schema.prisma:549)
  postalCity: "plain", // `String?` (schema.prisma:550)
  postalRegion: "plain", // `String?` (schema.prisma:551)
  postalPostalCode: "plain", // `String?` (schema.prisma:552)
  postalCountry: "plain", // `String?` (schema.prisma:553)

  // --- OR booleans ----------------------------------------------------------
  requiresInduction: "plain", // `Boolean` (schema.prisma:574)
  hutLeaderEligible: "plain", // `Boolean` (schema.prisma:575)

  // --- Derived rows ---------------------------------------------------------
  // `DateTime?` (schema.prisma:576). One writer: the hut-leader induction's
  // completion side effect (induction.ts:147), whose `completedAt` is
  // `new Date()` (induction.ts:222,284). A true instant.
  hutLeaderEligibleAt: "instant",
  // `DateTime?` (schema.prisma:570). Admin-editable through a date input,
  // validated `^\d{4}-\d{2}-\d{2}$` and parsed to UTC midnight
  // (admin-member-detail-service.ts:1161, admin-members-service.ts:1458);
  // `parseDateOnly` on CSV import; and on the Xero backfill it is the first
  // invoice's date (xero-bulk-contact-sync.ts:439), which is a Xero date-only
  // field. A membership start date, not a moment.
  joinedDate: "calendarDay",
};

/**
 * The declared kind for a merged field. Unknown fields fall back to `"plain"`,
 * which renders the raw value: visibly odd for a date, and impossible to be
 * quietly a day wrong. The exhaustiveness test is what stops a new merged field
 * reaching that fallback in the first place.
 */
export function mergeFieldValueKind(field: string): MergeFieldValueKind {
  return MERGE_FIELD_VALUE_KINDS[field] ?? "plain";
}

/** Shown for a value that is absent or empty. */
const EMPTY_DISPLAY = "—";

function toInstant(value: unknown): Date | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Render one merge-comparison value, given what it means.
 *
 * Dates come back as `yyyy-MM-dd` either way — the fix changes WHICH day an
 * instant lands on, not the shape of the column:
 *
 * - `instant` reads the club's calendar day (`formatDateOnlyForTimeZone`,
 *   `INV-DATE-019`), which is correct in every zone.
 * - `calendarDay` reads the UTC-midnight encoding by truncation
 *   (`formatDateOnly`, `INV-DATE-010`), which is also correct in every zone —
 *   and deliberately NOT routed through the club-zone formatter, which would
 *   agree in New Zealand and be a day wrong for a club behind UTC.
 *
 * Values arrive over JSON as ISO strings, and in server-side/unit contexts as
 * `Date`s; both are accepted, and both take the same branch, so the two cannot
 * drift apart.
 *
 * `timeZone` follows the same convention as every helper in `date-only.ts`: it
 * defaults to the club's zone and production never passes it. It exists so the
 * two branches are DECIDABLE. New Zealand sits ahead of UTC, where truncation
 * and the club-zone formatter agree on a calendar day, so a test run only in the
 * club's own zone cannot fail the mutation that routes calendar days through the
 * club-zone formatter. Passing a zone behind UTC is what separates them — and it
 * is passed here rather than set via `TZ`, which would move `APP_TIME_ZONE`
 * itself (docs/TESTING.md rule 6).
 */
export function formatMergeFieldValue(
  value: unknown,
  kind: MergeFieldValueKind,
  timeZone: string = APP_TIME_ZONE,
): string {
  if (value === null || value === undefined || value === "") {
    return EMPTY_DISPLAY;
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (kind === "plain") return String(value);

  const instant = toInstant(value);
  if (!instant) return String(value);

  // `formatDateOnly` takes no zone on purpose: a calendar day is already pinned
  // to UTC midnight, so truncation names the same day from anywhere.
  return kind === "instant"
    ? formatDateOnlyForTimeZone(instant, timeZone)
    : formatDateOnly(instant);
}
