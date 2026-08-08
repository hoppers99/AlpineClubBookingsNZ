/**
 * AI Diagnostics — AID-6B booking/membership pack, part 1: BOUNDED RECORD
 * SELECTION (#2376, epic #2369).
 *
 * TWO ENTRIES, AND THEY ARE THE ONLY WAY INTO THE PACK. Every other entry takes an
 * exact record id, so an operator (and the model acting for them) has to FIND the
 * booking or the member before any detail is retrievable. That ordering is what
 * #2376 asks for — "require selection of a specific record before returning
 * detailed evidence" — and it is what makes "no bulk extraction" a property of the
 * pack rather than a promise about how it will be used.
 *
 *   diagnostics.booking_search   bookings
 *   diagnostics.member_search    membership
 *
 * PERMISSIONS, AND WHY THEY ARE SEPARATE ENTRIES RATHER THAN ONE TOOL WITH A
 * `subject` ARGUMENT. `booking_search` requires `bookings:view` and nothing else;
 * `member_search` requires `membership:view` and nothing else. A Booking Officer
 * without membership access can find a booking; a Membership Officer without
 * booking access can find a member; neither needs `support:view`, which is #2376's
 * owner decision and its first two acceptance criteria.
 *
 * That is only true because they are two entries. `requiredAreas` is fixed on the
 * entry and `invoke.ts` authorizes BEFORE it parses arguments, so an argument can
 * never move a call between permission sets. One `record_search` tool taking
 * `subject: "booking" | "member"` would have had to declare both areas (denying
 * each officer the half they are entitled to) or one area (letting a Booking Officer
 * search the membership roll). There is no third option, so there are two tools.
 *
 * WHY A SEARCH IS SAFE HERE, stated as properties rather than intentions. Each is
 * pinned by a test:
 *
 *  - NO PATTERN LANGUAGE ANYWHERE. Every predicate is `=` except the ONE name
 *    prefix, which uses `pg_catalog.starts_with` — a function taking a literal
 *    prefix, with no metacharacters at all. There is no `LIKE`, no `ILIKE`, no
 *    `SIMILAR TO` and no regex operator in this module, so a `%` or a `_` in a term
 *    has nothing to mean even if the schema let one through, which it does not.
 *  - BLANK IS A REJECTION. `{}` does not parse for either entry. There is no
 *    optional-term arm, no "show all", and no default that lists recent records.
 *  - THE DATE RANGE IS A CLOSED ENUM. The lodge-night search's window is `1d`, `7d`
 *    or `30d` and nothing else, so #2376's ban on an unrestricted date range is a
 *    TYPE rather than a check.
 *  - CAPPED AND DETERMINISTIC. Ten rows with a TOTAL `ORDER BY` (the record id is
 *    always the final tiebreaker), so identical evidence hashes identically for the
 *    audit trail.
 *  - AMBIGUITY IS REPORTED, NOT RESOLVED. A booking reference is the uppercase
 *    first eight characters of a cuid and is NOT unique; a surname prefix matches
 *    families. Both return every match up to the cap and tell the model to make the
 *    operator choose. Neither ever picks one.
 *
 * WHAT A SEARCH ROW DELIBERATELY DOES NOT CARRY, and this is the difference between
 * a search and a report. A MEMBER search row carries the member's name, age tier,
 * lifecycle state, login state and record id — and BOOLEANS for whether an email
 * address and a phone number are on file. It does NOT carry the address or the
 * number. Those two columns are granted so they can be the PREDICATE an operator
 * already holds, and the email itself is returned by exactly one per-record entry,
 * for exactly one selected member, under the same permission. A harvested page of
 * search rows is therefore a list of names, which is what the admin members table
 * already shows the same officer.
 *
 * WHAT BOUNDS ENUMERATION, stated honestly rather than overclaimed — because the
 * finance pack's review caught exactly this kind of sentence being stronger than the
 * code. A three-character surname prefix capped at ten rows is walkable in
 * principle. What bounds it is not the cap: it is the substrate's per-session
 * ceiling of sixteen tool calls (so one session sees at most 160 search rows however
 * it spends them), one approved-metadata audit row per invocation with the argument
 * HASH recorded, and the per-question budget reservation. There is no listing tool,
 * no wildcard, no COUNT, and no way to page: the cap is not an offset.
 *
 * THE PLAN, AND WHY IT IS ACCEPTABLE. `Member."email"` is indexed;
 * `firstName`/`lastName` and the phone columns are not, so a name or mobile search
 * is a sequential scan of `Member`. At club scale that relation is in the thousands
 * of rows and the scan is milliseconds; the 5-second `statement_timeout` is the
 * backstop and a timeout is reported honestly as `query_failed` rather than as an
 * absence. `Booking` is indexed on `memberId`, `lodgeId` and `[checkIn, checkOut]`,
 * so every booking search but the reference one is an index scan.
 */

import "server-only";

import { z } from "zod";

import { defineDiagnosticsTool, type DiagnosticsToolEntry } from "../define";
import {
  AID6B_BYTE_LIMIT,
  AID6B_DEFAULT_SEARCH_WINDOW,
  AID6B_DESCRIPTION_TAIL,
  AID6B_MIN_NAME_SEARCH_CHARS,
  AID6B_SCOPE_TAIL,
  AID6B_SEARCH_ROW_LIMIT,
  AID6B_SEARCH_WINDOWS,
  AID6B_SEARCH_WINDOW_KEYS,
  AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE,
  EMAIL_SEARCH_TERM,
  NAME_SEARCH_TERM,
  NZ_DATE_ONLY,
  PHONE_SEARCH_TERM,
  dateOnly,
  dateOnlyOrNull,
  personNameOrNull,
} from "./booking-shared";
import {
  RECORD_ID,
  boolOf,
  centsOrZero,
  countOf,
  instantOrNull,
  recordRefOrNull,
  stableCodeOrNull,
  utcInstant,
} from "./finance-shared";

export const DIAGNOSTICS_BOOKING_SEARCH_TOOL_ID = "diagnostics.booking_search";
export const DIAGNOSTICS_MEMBER_SEARCH_TOOL_ID = "diagnostics.member_search";

// ---------------------------------------------------------------------------
// 1. Booking search.
// ---------------------------------------------------------------------------

/**
 * The closed set of ways an operator may locate a booking. A discriminated union
 * rather than a free "field" argument, so the predicate is fixed at review time:
 * the model chooses WHICH of four server-written searches to run, never what to
 * compare or where.
 *
 * `booking_reference` needs a note because the obvious reading is wrong. It is NOT
 * a column: it is the uppercase first eight characters of the booking's cuid
 * (`formatBookingReference`), which is what a member reads off a confirmation
 * email, and it is NOT unique. The predicate compares `left("id", 8)` against the
 * lower-cased term, and several bookings can legitimately match.
 */
export const BOOKING_SEARCH_KINDS = [
  "booking_id",
  "booking_reference",
  "owner_member_id",
  "lodge_nights",
] as const;

/** The booking-reference shape: exactly eight alphanumeric characters. */
const BOOKING_REFERENCE_SHAPE = /^[A-Za-z0-9]{8}$/;

/**
 * One argument object with a `kind` discriminant and per-kind requirements
 * enforced in a `superRefine`, rather than a `z.discriminatedUnion`.
 *
 * That choice is deliberate and it is about the JSON Schema handed to the provider,
 * not about zod. `DiagnosticsToolInputSchema` is a flat object with
 * `additionalProperties: false`, so a union arm cannot be expressed to the model at
 * all; a flat object with a `kind` enum and optional siblings can, and the
 * `superRefine` is what makes the combination that the schema cannot express — "a
 * `lodge_nights` search without a lodge id" — a REJECTION rather than a query with
 * a null parameter.
 */
const bookingSearchArgsSchema = z
  .object({
    kind: z.enum(BOOKING_SEARCH_KINDS),
    /** For `booking_id` and `owner_member_id`. */
    recordId: RECORD_ID.optional(),
    /** For `booking_reference`. */
    bookingReference: z.string().min(8).max(8).optional(),
    /** For `lodge_nights`. */
    lodgeId: RECORD_ID.optional(),
    nightFrom: NZ_DATE_ONLY.optional(),
    window: z.enum(AID6B_SEARCH_WINDOW_KEYS).default(AID6B_DEFAULT_SEARCH_WINDOW),
  })
  .strict()
  .superRefine((value, ctx) => {
    const require = (present: boolean, path: string, message: string) => {
      if (!present) ctx.addIssue({ code: "custom", path: [path], message });
    };
    if (value.kind === "booking_id" || value.kind === "owner_member_id") {
      require(
        value.recordId !== undefined,
        "recordId",
        "this search needs a record id",
      );
      return;
    }
    if (value.kind === "booking_reference") {
      require(
        value.bookingReference !== undefined &&
          BOOKING_REFERENCE_SHAPE.test(value.bookingReference),
        "bookingReference",
        "expected an eight-character booking reference",
      );
      return;
    }
    require(value.lodgeId !== undefined, "lodgeId", "this search needs a lodge id");
    require(
      value.nightFrom !== undefined,
      "nightFrom",
      "this search needs a first night",
    );
  });

type BookingSearchArgs = z.infer<typeof bookingSearchArgsSchema>;

/**
 * The columns every booking search row carries. Enough to RECOGNISE the right
 * booking — the reference, the lodge, the nights, the lifecycle state, the party
 * size and the flags an operator is most likely to be asking about — and nothing
 * that would make a harvested list worth having.
 *
 * `owner_member_ref` IS projected, and it is the one identifier here that names a
 * person. It has to be: the whole point of a booking search is to hand the exact
 * ids the per-record entries need, and `member_diagnostic_summary` is the entry
 * that turns an owner id into a name — under `membership:view`, which this entry
 * does not require. So a Booking Officer without membership access gets an
 * opaque id, which is exactly the boundary #2376 draws.
 *
 * `deleted_at_utc` is projected on every row and never filtered out. A
 * soft-deleted booking is still a row, and an operator investigating "the booking
 * has vanished" is looking for precisely that row; hiding it would make the tool
 * answer `not_found` for a record that exists.
 */
const BOOKING_SEARCH_COLUMNS = `b."id" AS booking_ref,
  pg_catalog.upper(pg_catalog.left(b."id", 8)) AS booking_reference,
  b."memberId" AS owner_member_ref,
  b."lodgeId" AS lodge_ref,
  l."name" AS lodge_name,
  b."status"::text AS booking_status,
  ${dateOnly('b."checkIn"')} AS check_in,
  ${dateOnly('b."checkOut"')} AS check_out,
  (SELECT pg_catalog.count(*)::int FROM public."BookingGuest" g WHERE g."bookingId" = b."id") AS guest_count,
  b."finalPriceCents" AS final_price_cents,
  b."hasNonMembers" AS has_non_members,
  (b."parentBookingId" IS NOT NULL) AS is_linked_child,
  b."requiresAdminReview" AS requires_admin_review,
  b."adminReviewStatus"::text AS admin_review_status,
  b."adultMemberHostingReviewStatus"::text AS hosting_review_status,
  b."waitlistPosition" AS waitlist_position,
  b."wholeLodgeHold" AS whole_lodge_hold,
  (b."adminCapacityHoldAt" IS NOT NULL) AS admin_capacity_hold,
  (b."capacityOverriddenAt" IS NOT NULL) AS capacity_overridden,
  ${utcInstant('b."deletedAt"')} AS deleted_at_utc,
  ${utcInstant('b."createdAt"')} AS created_at_utc,
  ${utcInstant('b."updatedAt"')} AS updated_at_utc`;

/**
 * The four searches, written out once and fixed at review time. `$1` selects which
 * arm is live; `$2..$5` are the terms. Every one is a bound parameter — nothing is
 * formatted into this statement, and the kind cannot name a column.
 *
 * `pg_catalog.` qualification throughout for the same reason `database.ts` pins
 * `search_path`: the statement that decides which records an operator can reach
 * must not depend on schema-resolution order.
 *
 * THE LODGE-NIGHTS ARM IS AN OVERLAP TEST, NOT A CHECK-IN RANGE. `checkIn < end AND
 * checkOut > start` is the half-open interval every capacity query in this platform
 * uses (`bookingsOverlap`, `capacityHoldingBookingFilter`), and it is the right
 * question: an operator asking "what is at the lodge that week" means bookings
 * PRESENT on those nights, not bookings that started in them. A check-in-range
 * filter would silently omit the long stay that is the usual reason the lodge is
 * full.
 */
const BOOKING_SEARCH_SQL = `SELECT
  ${BOOKING_SEARCH_COLUMNS}
FROM public."Booking" b
LEFT JOIN public."Lodge" l ON l."id" = b."lodgeId"
WHERE (
  ($1::text = 'booking_id' AND b."id" = $2::text)
  OR ($1::text = 'owner_member_id' AND b."memberId" = $2::text)
  OR ($1::text = 'booking_reference' AND pg_catalog.left(b."id", 8) = pg_catalog.lower($3::text))
  OR ($1::text = 'lodge_nights' AND b."lodgeId" = $4::text
      AND b."checkIn" < ($5::date + (($6)::int * INTERVAL '1 day'))
      AND b."checkOut" > $5::date)
)
ORDER BY b."checkIn" DESC, b."id" ASC`;

/** The projection the booking search uses. Flat scalars, one fixed shape. */
function projectBookingSearchRow(row: Record<string, unknown>) {
  return {
    bookingRef: recordRefOrNull(row.booking_ref) ?? "",
    bookingReference: recordRefOrNull(row.booking_reference) ?? "",
    ownerMemberRef: recordRefOrNull(row.owner_member_ref) ?? "",
    lodgeRef: recordRefOrNull(row.lodge_ref) ?? "",
    lodgeName: personNameOrNull(row.lodge_name),
    bookingStatus: stableCodeOrNull(row.booking_status),
    checkIn: dateOnlyOrNull(row.check_in) ?? "",
    checkOut: dateOnlyOrNull(row.check_out) ?? "",
    guestCount: countOf(row.guest_count),
    finalPriceCents: centsOrZero(row.final_price_cents),
    hasNonMembers: boolOf(row.has_non_members),
    isLinkedChild: boolOf(row.is_linked_child),
    requiresAdminReview: boolOf(row.requires_admin_review),
    adminReviewStatus: stableCodeOrNull(row.admin_review_status),
    hostingReviewStatus: stableCodeOrNull(row.hosting_review_status),
    waitlistPosition: countOf(row.waitlist_position),
    wholeLodgeHold: boolOf(row.whole_lodge_hold),
    adminCapacityHold: boolOf(row.admin_capacity_hold),
    capacityOverridden: boolOf(row.capacity_overridden),
    deletedAtUtc: instantOrNull(row.deleted_at_utc),
    createdAtUtc: instantOrNull(row.created_at_utc) ?? "",
    updatedAtUtc: instantOrNull(row.updated_at_utc) ?? "",
  };
}

const bookingSearch = defineDiagnosticsTool<BookingSearchArgs>({
  id: DIAGNOSTICS_BOOKING_SEARCH_TOOL_ID,
  source: "select_only_sql",
  label: "Find a booking",
  description: `Finds a booking one of four ways: by its exact record id, by the eight-character booking reference a member sees on their confirmation, by the exact record id of the member who OWNS it, or by a lodge plus a first night and a short window (1d, 7d or 30d — 7d by default). Use it FIRST: every other booking tool needs the exact booking id this returns. Exact matches only — there are no partial, wildcard or blank searches, and it returns at most ${AID6B_SEARCH_ROW_LIMIT} rows, latest nights first. Each row carries the booking id and reference, the owner's member id (not their name — that needs membership access), the lodge id and name, the status, the check-in and check-out nights, the number of guests, the final price in integer cents, whether the party includes non-members, whether it is a linked child booking, the review and hosting-review state, the waitlist position, the whole-lodge, admin-capacity-hold and capacity-override flags, and when it was deleted, created and last changed. The booking reference is NOT unique — if several rows come back, ask the operator which booking they mean rather than choosing one. ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["bookings"],
  evidenceScope: `Bookings matching ONE exact identifier, or present at one lodge across a short window of nights. The lodge-night search is an OVERLAP test — it returns every booking PRESENT on those nights, including one that checked in earlier — which is the population the capacity engine counts. A booking reference is only the first eight characters of the booking id and is NOT unique, so more than one row can legitimately match. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: bookingSearchArgsSchema,
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [...BOOKING_SEARCH_KINDS],
        description:
          "Which search to run. booking_id and owner_member_id need recordId; booking_reference needs bookingReference; lodge_nights needs lodgeId and nightFrom.",
      },
      recordId: {
        type: "string",
        description:
          "The EXACT booking record id (kind=booking_id) or the EXACT member record id of the booking owner (kind=owner_member_id).",
      },
      bookingReference: {
        type: "string",
        description:
          "The eight-character booking reference a member sees on their confirmation. NOT unique — several bookings can share one.",
      },
      lodgeId: {
        type: "string",
        description: "The EXACT lodge record id (kind=lodge_nights).",
      },
      nightFrom: {
        type: "string",
        description:
          "The first New Zealand lodge night to look at, as YYYY-MM-DD. No time, no timezone (kind=lodge_nights).",
      },
      window: {
        type: "string",
        enum: [...AID6B_SEARCH_WINDOW_KEYS],
        description:
          "How many nights from nightFrom to cover. Defaults to 7d. 30d is the maximum.",
      },
    },
    required: ["kind"],
    additionalProperties: false,
  },
  sql: BOOKING_SEARCH_SQL,
  /**
   * SIX parameters, ALWAYS, in this order, whichever kind is live — and the
   * unused ones are bound to a value that cannot match rather than omitted.
   *
   * That is not tidiness. `runDiagnosticsReadOnlyQuery` appends the row cap as the
   * NEXT `$n`, so a `bind` that returned four parameters for a statement
   * referencing six would alias the row cap onto `$5`, and a search would silently
   * compare a date against the number 10. `registry.test.ts` pins the arity at
   * review time and the executor refuses a mismatch at runtime; this comment is why
   * both exist.
   *
   * The dead terms are `''` for the text arms — no cuid, booking reference or lodge
   * id is the empty string, and the arm they belong to is gated on `$1` anyway — and
   * a fixed epoch date for the night, chosen because a `::date` cast of `''` is a
   * query ERROR rather than a non-match, which would turn an unrelated search into
   * `query_failed`.
   */
  bind: (args) => [
    args.kind,
    args.recordId ?? "",
    args.bookingReference ?? "",
    args.lodgeId ?? "",
    args.nightFrom ?? "1970-01-01",
    AID6B_SEARCH_WINDOWS[args.window],
  ],
  project: projectBookingSearchRow,
  rowLimit: AID6B_SEARCH_ROW_LIMIT,
  byteLimit: AID6B_BYTE_LIMIT,
  // A lodge name is club-set text, and no row carries a person's name — but every
  // row carries a member id, which identifies a person to anyone who can resolve
  // it. ADR-004's per-invocation opt-in applies.
  surfacesPersonalData: true,
});

// ---------------------------------------------------------------------------
// 2. Member search.
// ---------------------------------------------------------------------------

/**
 * The closed set of ways an operator may locate a member.
 *
 * THERE IS NO `member_number` KIND, AND THAT IS A FINDING RATHER THAN AN OMISSION.
 * #2376 asks for a member-number search. This schema has no member-number column:
 * `Member` carries a cuid `id`, an `email`, and a `xeroContactId`, and a grep of the
 * whole tree for `memberNumber`/`membershipNumber` returns nothing but one comment
 * in `member-merge.ts`. A tool offering the search would be inventing a concept the
 * platform does not have, and a model handed such a tool would tell an officer to
 * read a number off a card that does not exist. The pack doc records this under
 * "what this pack cannot answer".
 *
 * `name_prefix` is the one non-equality predicate in the whole pack, and #2376
 * authorises it in as many words ("exact or partial name"). It matches the START of
 * either given or family name, case-folded, via `pg_catalog.starts_with` — a
 * function over a literal prefix, not a pattern. It is the same shape and the same
 * ten-row cap the member-facing guest finder already uses
 * (`searchMemberGuestCandidatesByName`), which is the precedent for "a prefix search
 * over the roll is an accepted membership-administration workflow here".
 */
export const MEMBER_SEARCH_KINDS = [
  "member_id",
  "email_exact",
  "name_prefix",
  "mobile",
] as const;

const memberSearchArgsSchema = z
  .object({
    kind: z.enum(MEMBER_SEARCH_KINDS),
    /** For `member_id`. */
    recordId: RECORD_ID.optional(),
    /** For `email_exact`. */
    email: EMAIL_SEARCH_TERM.optional(),
    /** For `name_prefix`. */
    namePrefix: NAME_SEARCH_TERM.optional(),
    /** For `mobile`. Normalised to digits by the schema. */
    mobile: PHONE_SEARCH_TERM.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const need = (present: boolean, path: string) => {
      if (!present) {
        ctx.addIssue({
          code: "custom",
          path: [path],
          message: "this search needs its own term",
        });
      }
    };
    if (value.kind === "member_id") need(value.recordId !== undefined, "recordId");
    if (value.kind === "email_exact") need(value.email !== undefined, "email");
    if (value.kind === "name_prefix") {
      need(value.namePrefix !== undefined, "namePrefix");
    }
    if (value.kind === "mobile") need(value.mobile !== undefined, "mobile");
  });

type MemberSearchArgs = z.infer<typeof memberSearchArgsSchema>;

/**
 * The columns a member search row carries.
 *
 * `has_email` AND `has_phone` ARE BOOLEANS, AND THE VALUES ARE NOT PROJECTED. That
 * is the single most important line in this module. `Member."email"` and the three
 * phone columns are granted to the SELECT-only role so they can be the PREDICATE an
 * operator already holds — they typed the address in — and the address itself is
 * returned by exactly one entry (`member_diagnostic_summary`) for exactly one
 * SELECTED member. So a name-prefix search yields a page of names and states, which
 * is what the admin members table already shows the same officer, and never a page
 * of contactable addresses.
 *
 * NO DATE OF BIRTH, and none is granted. Age-based eligibility in this platform is
 * decided on `ageTier` — `AgeTierSetting` keys the subscription rule on it,
 * `BookingGuest` stores it, and `participantQualifiesAsHost` reads it — so the tier
 * is the authoritative fact and the birth date is not needed to report eligibility.
 * The admin family-group search sets the same precedent, returning a calculated age
 * label and never the date.
 *
 * `lifecycle_deleted` is `active = false AND cancelledAt IS NULL AND archivedAt IS
 * NULL`, and it exists because an ANONYMISED account is exactly that shape: erasure
 * stamps neither instant, so a naive three-column read reports an erased member as
 * merely "Inactive". The authoritative label comes from
 * `member_eligibility_state`, which runs the platform's own resolver; this flag is
 * the search's warning that the two are not the same question.
 */
const MEMBER_SEARCH_COLUMNS = `m."id" AS member_ref,
  m."firstName" AS first_name,
  m."lastName" AS last_name,
  m."ageTier"::text AS age_tier,
  m."active" AS is_active,
  m."canLogin" AS can_login,
  (m."cancelledAt" IS NOT NULL) AS is_cancelled,
  (m."archivedAt" IS NOT NULL) AS is_archived,
  (m."active" = false AND m."cancelledAt" IS NULL AND m."archivedAt" IS NULL) AS lifecycle_deleted,
  (m."email" IS NOT NULL AND m."email" <> '') AS has_email,
  (m."phoneNumber" IS NOT NULL AND m."phoneNumber" <> '') AS has_phone,
  (m."xeroContactId" IS NOT NULL) AS has_xero_contact,
  (m."parentMemberId" IS NOT NULL OR m."secondaryParentId" IS NOT NULL) AS has_parent_link,
  m."requiresInduction" AS requires_induction,
  ${dateOnly('m."joinedDate"')} AS joined_date,
  ${utcInstant('m."createdAt"')} AS created_at_utc,
  ${utcInstant('m."updatedAt"')} AS updated_at_utc`;

/**
 * The four member searches. `$1` selects the arm; `$2..$5` are the terms.
 *
 * THE MOBILE ARM MATCHES THREE STORED SPELLINGS OF ONE NUMBER, and it has to. This
 * schema stores a phone as Xero does — `phoneCountryCode` / `phoneAreaCode` /
 * `phoneNumber` — so the digits an operator reads off a message ("0274224115") are
 * spread across two columns with a leading zero that is stored nowhere. The
 * predicate therefore compares the normalised term against the bare number, against
 * area-plus-number, and against a leading zero plus area-plus-number. All three are
 * equalities against a concatenation of granted columns; no term is used as a
 * pattern, and `coalesce` keeps a null column from turning the whole concatenation
 * null and silently matching nothing.
 *
 * The name arm case-folds BOTH sides. `Member."firstName"`/`"lastName"` are stored
 * as entered, and an officer typing a surname in lower case is the normal case, not
 * the exception.
 */
const MEMBER_SEARCH_SQL = `SELECT
  ${MEMBER_SEARCH_COLUMNS}
FROM public."Member" m
WHERE (
  ($1::text = 'member_id' AND m."id" = $2::text)
  OR ($1::text = 'email_exact' AND pg_catalog.lower(m."email") = pg_catalog.lower($3::text))
  OR ($1::text = 'name_prefix' AND (
    pg_catalog.starts_with(pg_catalog.lower(m."lastName"), pg_catalog.lower($4::text))
    OR pg_catalog.starts_with(pg_catalog.lower(m."firstName"), pg_catalog.lower($4::text))
  ))
  OR ($1::text = 'mobile' AND (
    pg_catalog.coalesce(m."phoneNumber", '') = $5::text
    OR pg_catalog.coalesce(m."phoneAreaCode", '') || pg_catalog.coalesce(m."phoneNumber", '') = $5::text
    OR '0' || pg_catalog.coalesce(m."phoneAreaCode", '') || pg_catalog.coalesce(m."phoneNumber", '') = $5::text
  ))
)
ORDER BY m."lastName" ASC, m."firstName" ASC, m."id" ASC`;

const memberSearch = defineDiagnosticsTool<MemberSearchArgs>({
  id: DIAGNOSTICS_MEMBER_SEARCH_TOOL_ID,
  source: "select_only_sql",
  label: "Find a member",
  description: `Finds a member one of four ways: by their exact record id, by their exact email address, by the START of their given or family name (at least ${AID6B_MIN_NAME_SEARCH_CHARS} characters, case-insensitive), or by their mobile number. Use it FIRST: every other membership tool needs the exact member id this returns. There is NO member-number search, because this platform stores no member number — the record id, the email address and the Xero contact link are the identifiers it has. At most ${AID6B_SEARCH_ROW_LIMIT} rows, family name then given name then id. Each row carries the member id, the given and family name, the age tier, whether the account is active, can log in, is cancelled or is archived, whether an email address and a phone number are ON FILE (the values themselves are NOT returned by a search — use the member summary for one selected member), whether a Xero contact is linked, whether a parent link exists, whether an induction is required of them, the joined date and the created and last-changed instants. A name prefix matches families — if several rows come back, ask the operator which member they mean rather than choosing one. ${AID6B_DESCRIPTION_TAIL}`,
  requiredAreas: ["membership"],
  evidenceScope: `Members matching ONE exact identifier, or whose given or family name STARTS WITH the term. It searches the whole membership roll including inactive, cancelled and archived members, because a question about a member who cannot book is usually a question about one of those. A search row deliberately reports only WHETHER an email address and a phone number are on file, never the values. There is no member number in this platform, so a member who quotes one is quoting something else — probably a Xero contact number or an invoice number, which are finance records this tool does not search. An "active = false" member with neither a cancellation nor an archival instant may be an ERASED account rather than a merely inactive one; the lifecycleDeleted flag marks that shape and diagnostics.member_eligibility_state gives the platform's own authoritative label. ${AID6B_SCOPE_TAIL} ${AID6B_UNTRUSTED_EVIDENCE_DISCLOSURE}`,
  argsSchema: memberSearchArgsSchema,
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: [...MEMBER_SEARCH_KINDS],
        description:
          "Which search to run. Each kind needs its own term: member_id needs recordId, email_exact needs email, name_prefix needs namePrefix, mobile needs mobile.",
      },
      recordId: {
        type: "string",
        description: "The EXACT member record id (kind=member_id).",
      },
      email: {
        type: "string",
        description:
          "The EXACT email address, case-insensitive. No partial matches (kind=email_exact).",
      },
      namePrefix: {
        type: "string",
        description: `The START of a given or family name, at least ${AID6B_MIN_NAME_SEARCH_CHARS} characters, case-insensitive. Letters, spaces, hyphens and apostrophes only — no wildcards (kind=name_prefix).`,
      },
      mobile: {
        type: "string",
        description:
          "A phone number. Spaces, brackets, plus and hyphens are ignored; the digits are matched exactly against the stored number, with or without the area code and leading zero (kind=mobile).",
      },
    },
    required: ["kind"],
    additionalProperties: false,
  },
  sql: MEMBER_SEARCH_SQL,
  /**
   * FIVE parameters, ALWAYS, in this order — see the booking search's `bind` for
   * why the unused arms are bound to a non-matching value rather than omitted.
   *
   * `''` is safe for every dead term here: no member id, email address, name or
   * phone number is the empty string, `starts_with(x, '')` is only reached when
   * `$1` already says otherwise, and the phone comparison's `coalesce(...) = ''`
   * would need a member with a null area code AND a null number, whose arm is
   * likewise gated off.
   */
  bind: (args) => [
    args.kind,
    args.recordId ?? "",
    args.email ?? "",
    args.namePrefix ?? "",
    args.mobile ?? "",
  ],
  project: (row) => ({
    memberRef: recordRefOrNull(row.member_ref) ?? "",
    firstName: personNameOrNull(row.first_name),
    lastName: personNameOrNull(row.last_name),
    ageTier: stableCodeOrNull(row.age_tier),
    isActive: boolOf(row.is_active),
    canLogin: boolOf(row.can_login),
    isCancelled: boolOf(row.is_cancelled),
    isArchived: boolOf(row.is_archived),
    lifecycleDeleted: boolOf(row.lifecycle_deleted),
    hasEmail: boolOf(row.has_email),
    hasPhone: boolOf(row.has_phone),
    hasXeroContact: boolOf(row.has_xero_contact),
    hasParentLink: boolOf(row.has_parent_link),
    requiresInduction: boolOf(row.requires_induction),
    joinedDate: dateOnlyOrNull(row.joined_date),
    createdAtUtc: instantOrNull(row.created_at_utc) ?? "",
    updatedAtUtc: instantOrNull(row.updated_at_utc) ?? "",
  }),
  rowLimit: AID6B_SEARCH_ROW_LIMIT,
  byteLimit: AID6B_BYTE_LIMIT,
  surfacesPersonalData: true,
});

/** The AID-6B search half, in presentation order. */
export const DIAGNOSTICS_AID6B_SEARCH_TOOLS: readonly DiagnosticsToolEntry[] = [
  bookingSearch,
  memberSearch,
];
