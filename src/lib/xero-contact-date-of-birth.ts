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
 *     day, every hour of every day. Those two wrote 364 of the 375 stored dates
 *     of birth on the live site.
 *   - `xero-inbound/contact.ts` and `xero-operation-retry.ts` built
 *     `Date.UTC(...)`, which is right.
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
 */
const XERO_CONTACT_DATE_OF_BIRTH_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** True when a stored Xero `companyNumber` is this club's date-of-birth shape. */
export function isXeroContactDateOfBirthShape(
  companyNumber: string | null | undefined,
): boolean {
  return Boolean(
    companyNumber && XERO_CONTACT_DATE_OF_BIRTH_PATTERN.test(companyNumber),
  );
}

/**
 * A Xero contact's `companyNumber` as a date-only `Date` at UTC midnight, or
 * `null` when the field is empty, differently shaped, or names a day that does
 * not exist (`31/02/1990`).
 *
 * `parseDateOnly` rejects the impossible day by round-tripping it, which is the
 * same outcome the four predecessors reached via `Invalid Date` — only now the
 * instant it returns for a real day is the day itself rather than the evening
 * before it.
 */
export function parseXeroContactDateOfBirth(
  companyNumber: string | null | undefined,
): Date | null {
  if (!companyNumber) {
    return null;
  }

  const match = companyNumber.match(XERO_CONTACT_DATE_OF_BIRTH_PATTERN);
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
 */
export function formatXeroContactDateOfBirth(
  dateOfBirth: Date | null | undefined,
): string | null {
  if (!dateOfBirth || Number.isNaN(dateOfBirth.getTime())) {
    return null;
  }

  const [yyyy, mm, dd] = formatDateOnly(dateOfBirth).split("-");
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * The `companyNumber` field of an outbound contact payload — as a spreadable
 * partial, so "leave it alone" is expressed by having no key at all.
 *
 * TWO THINGS THIS MUST NEVER DO, and both are silent losses of somebody else's
 * data rather than bugs anyone would notice from this app:
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
 *     and not `dd/mm/yyyy`-shaped it is not a date of birth — it is that real
 *     NZBN again — and a date of birth does not get to overwrite it. If it is
 *     empty, or already date-shaped, this app's value wins: an administrator
 *     maintains a member's date of birth here, and the Xero→app direction
 *     (`xero-inbound/contact.ts`) only ever fills a gap, so "app wins when it
 *     has one" is the non-looping half of that pair.
 *
 * `currentCompanyNumber` is `undefined` when nothing is known about the field —
 * a contact this app is creating, or one it has never cached. Creation has
 * nothing to clobber, and a contact this app created can hold nothing in that
 * field but this app's own writes, so unknown means write.
 */
export function buildXeroContactCompanyNumberPatch(
  dateOfBirth: Date | null | undefined,
  currentCompanyNumber?: string | null,
): { companyNumber: string } | Record<string, never> {
  const companyNumber = formatXeroContactDateOfBirth(dateOfBirth);
  if (!companyNumber) {
    return {};
  }

  const current = currentCompanyNumber?.trim();
  if (current && !isXeroContactDateOfBirthShape(current)) {
    return {};
  }

  return { companyNumber };
}
