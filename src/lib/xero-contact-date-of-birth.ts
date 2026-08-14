/**
 * The ONE encoder and decoder for the date of birth a Xero contact carries in
 * its `CompanyNumber` (NZBN) field.
 *
 * WHY THIS MODULE EXISTS (#2859)
 *
 * Four copies of the same `dd/mm/yyyy` parser had grown across the Xero surface,
 * and they did not agree:
 *
 *   - `xero-contacts.ts` and `api/admin/xero/import-member-contact/route.ts`
 *     built `new Date(\`${yyyy}-${mm}-${dd}T00:00:00\`)`. No `Z` and no offset,
 *     so JavaScript reads it as SERVER-LOCAL midnight; `Dockerfile` pins
 *     `TZ=Pacific/Auckland`, so the stored instant landed on the PREVIOUS UTC
 *     day, every hour of every day.
 *   - `xero-inbound/contact.ts` and `xero-operation-retry.ts` built
 *     `Date.UTC(...)`, which is right.
 *
 * HOW MANY ROWS THE DEFECT REACHED: **10 of the 375** members who hold a date of
 * birth on the live site — 6 stored at `11:00` (a daylight-time birthday, +13)
 * and 4 at `12:00` (standard time, +12). Not the 364/97% an earlier production
 * census reported; that measurement was inverted by an `AT TIME ZONE` on a naive
 * column and is retracted (#2859). The bulk of the membership came in through
 * one of the two CORRECT copies above, which is why the defective shape is rare
 * even though all 375 have a Xero contact. Corroborated rather than inferred:
 * every one of the 10 is exactly one day behind the date Xero itself holds for
 * that contact, and 273 of the 296 rows with a date-shaped witness agree exactly.
 *
 * The correct implementation already existed, twice, beside the defective one,
 * twice. So the fix is not "correct the parse" — it is "have one parse".
 *
 * THE ENCODING, both directions, stated once:
 *
 *   Xero holds `dd/mm/yyyy`. `Member.dateOfBirth` holds that calendar day at
 *   UTC midnight (INV-DATE-024), the same date-only encoding `parseDateOnly`
 *   produces for every other calendar-day value in this system. Reading is
 *   therefore `parseDateOnly`, and writing is `formatDateOnly` re-punctuated —
 *   both UTC, both exact inverses, neither touching the local clock.
 */

import { formatDateOnly, parseDateOnly } from "@/lib/date-only";

/**
 * The shape Xero's NZBN field carries when this club uses it for a date of
 * birth. Anything else in that field is NOT a date of birth — most importantly
 * a real New Zealand Business Number, which is what the field is actually for.
 *
 * Deliberately NOT exported, and deliberately not wrapped in a `looksLikeADate`
 * predicate. This module used to export both the pattern test and the parse, and
 * they disagreed: the pattern accepts `12/34/5678`, `31/02/1990`, `00/00/0000`
 * and `06/15/1985`, all of which the parse rejects. Anything asking "is this
 * field a date of birth?" must ask the ONE reader below, so that the answer the
 * guard acts on and the answer the importer acts on are the same answer.
 */
const XERO_CONTACT_DATE_OF_BIRTH_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/**
 * A Xero contact's `companyNumber` as a date-only `Date` at UTC midnight, or
 * `null` when the field is empty, differently shaped, or names a day that does
 * not exist (`31/02/1990`).
 *
 * REJECTING THE IMPOSSIBLE DAY IS A DELIBERATE TIGHTENING, not parity with what
 * came before. It would be comfortable to claim the four predecessors already
 * did this via `Invalid Date`; measured, none of them did. Every one silently
 * ROLLED OVER into the following month:
 *
 *   Date.UTC(1990, 1, 31)                 -> 1990-03-03
 *   new Date("1990-02-31T00:00:00")       -> 1990-03-03
 *   Date.UTC(1990, 12, 1)                 -> 1991-01-01
 *
 * So `31/02/1990` used to be stored as 3 March, and `01/13/1990` — a US-ordered
 * date an administrator could plausibly type into Xero — used to be stored as
 * 1 January 1991. Four call sites therefore change behaviour here, and they
 * change it in the only defensible direction: a field nobody can read as a real
 * calendar day is not a date of birth, and inventing one from it is worse than
 * importing none. `parseDateOnly` establishes that by round-tripping the day.
 */
export function parseXeroContactDateOfBirth(
  companyNumber: string | null | undefined,
): Date | null {
  if (!companyNumber) {
    return null;
  }

  // Trimmed HERE, not at the call sites, so that "is this field a date of
  // birth?" has exactly one answer for a given stored string. The guard used to
  // trim before asking and the six importers did not, so `" 15/06/1985"` was
  // `null` to every reader and yet writable past the guard — the two-predicate
  // disagreement this module exists to remove, in a second form.
  const match = companyNumber.trim().match(XERO_CONTACT_DATE_OF_BIRTH_PATTERN);
  if (!match) {
    return null;
  }

  const [, dd, mm, yyyy] = match;
  const parsed = parseDateOnly(`${yyyy}-${mm}-${dd}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * The `companyNumber` string to send Xero for a stored date of birth, or `null`
 * when there is none to send.
 *
 * UTC parts, deliberately (INV-DATE-024). A stored date of birth IS UTC
 * midnight on the member's birthday, so `formatDateOnly` reads back exactly the
 * day that was stored. Formatting through the club zone instead would look more
 * cautious and would be wrong: it happens to recover the intended day from the
 * old local-midnight shape only because New Zealand is east of UTC, and it
 * would move the day for a club deployed west of it.
 *
 * `null` — never `""` — is the whole point of the return type: see
 * `buildXeroContactCompanyNumberPatch` for why an empty string must never reach
 * Xero.
 *
 * The composed string is re-tested against the pattern before it is returned.
 * That is not ceremony: `formatDateOnly` is `toISOString().slice(0, 10)`, and
 * ECMAScript renders an expanded year with a sign and six digits, so the largest
 * representable `Date` yields `"+275760-09"` and the split produces the literal
 * string `"undefined/09/+275760"`. No writer in this app can currently hold such
 * a value, so this is defence in depth rather than a live defect — but the cost
 * is one comparison, and the alternative is the word `undefined` written into
 * somebody's Xero contact. It also makes the round-trip with
 * `parseXeroContactDateOfBirth` total rather than merely empirical: every string
 * this returns is one that reader accepts.
 */
export function formatXeroContactDateOfBirth(
  dateOfBirth: Date | null | undefined,
): string | null {
  if (!dateOfBirth || Number.isNaN(dateOfBirth.getTime())) {
    return null;
  }

  const [yyyy, mm, dd] = formatDateOnly(dateOfBirth).split("-");
  const companyNumber = `${dd}/${mm}/${yyyy}`;
  return XERO_CONTACT_DATE_OF_BIRTH_PATTERN.test(companyNumber)
    ? companyNumber
    : null;
}

/**
 * The `companyNumber` field of an outbound contact payload — as a spreadable
 * partial, so "leave it alone" is expressed by having no key at all.
 *
 * THREE THINGS THIS MUST NEVER DO, and every one is a silent loss of somebody
 * else's data rather than a bug anyone would notice from this app:
 *
 *  1. **Never send `""` for a member with no date of birth.** Xero's
 *     `CompanyNumber` IS the NZBN field. An organisation or school account
 *     (`ageTier: NOT_APPLICABLE`, no date of birth by definition) may carry a
 *     real New Zealand Business Number there, typed by the treasurer for the
 *     club's own accounting. Blanking it to express "this member has no date of
 *     birth" would destroy accounting data to state an absence nobody asked for.
 *     So absence is expressed by omission: the app asserts a date of birth it
 *     HOLDS and never asserts one it lacks.
 *
 *  2. **Never overwrite a value that is not a date.** `currentCompanyNumber` is
 *     what Xero is known to hold (from `XeroContactCache`). If it is non-empty
 *     and `parseXeroContactDateOfBirth` cannot read it as a calendar day it is
 *     not a date of birth — it is that real NZBN again — and a date of birth
 *     does not get to overwrite it. The test is that reader and not a shape
 *     pattern, because the two disagree: `12/34/5678`, `31/02/1990`,
 *     `00/00/0000`, `99/99/9999` and the US-ordered `06/15/1985` all match the
 *     pattern and are all things the importer refuses to read as a date. A
 *     value this app would not import is a value it must not overwrite. If the
 *     field is empty, or holds a day the reader accepts, this app's value wins:
 *     an administrator maintains a member's date of birth here, and the
 *     Xero→app direction (`xero-inbound/contact.ts`) only ever fills a gap, so
 *     "app wins when it has one" is the non-looping half of that pair.
 *
 *  3. **Never write when nothing is known about the field.** `undefined` means
 *     exactly that, and it is the ONLY reading that is safe. It used to mean
 *     "write" on the argument that a contact this app created can hold nothing
 *     there but this app's own writes — and that argument is false, because
 *     this app links contacts it did not create. `findOrCreateXeroContact`
 *     resolves a member onto a PRE-EXISTING Xero contact by email match, and
 *     failing that by exact-name match, and records how on the object link
 *     (`metadata.linkedVia: "email_match" | "name_match"`, written by
 *     `linkMatchedXeroContact`). Nothing on that path writes a contact-cache
 *     row, so a matched contact carrying a genuine NZBN an administrator typed
 *     in Xero presents to an update as "no cache row" — and the old reading
 *     replaced that number with a birthday, unrecoverably. Omission is the one
 *     direction that cannot destroy anything: the value is sent on the next
 *     update once the contact has been cached, and creation passes an explicit
 *     `null` because a contact that does not exist yet has nothing to clobber.
 */
export function buildXeroContactCompanyNumberPatch(
  dateOfBirth: Date | null | undefined,
  currentCompanyNumber?: string | null,
): { companyNumber: string } | Record<string, never> {
  const companyNumber = formatXeroContactDateOfBirth(dateOfBirth);
  if (!companyNumber) {
    return {};
  }

  if (currentCompanyNumber === undefined) {
    return {};
  }

  // The reader does its own trimming, so this hands it the raw stored string
  // and the two cannot disagree. The trim here is only to decide EMPTINESS —
  // a field holding nothing but whitespace is a field holding nothing.
  const current = currentCompanyNumber?.trim();
  if (current && !parseXeroContactDateOfBirth(currentCompanyNumber)) {
    return {};
  }

  return { companyNumber };
}
