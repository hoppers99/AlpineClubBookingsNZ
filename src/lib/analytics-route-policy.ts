import { isFixedNonceWebsitePath } from "@/lib/public-website-paths";

/**
 * WHERE Google Analytics may run, and WHAT it may be told about the URL (#2573,
 * owner decision section 7).
 *
 * The policy is FIXED and application-controlled. An administrator cannot select
 * tracked routes, cannot opt a route in, and cannot change what is sent — those
 * are all on section 2's not-configurable list. This module is the enforcement,
 * not a description of it: `analytics-route-policy.test.ts` pins both directions.
 *
 * Deliberately dependency-free apart from the route census: it runs in the browser
 * (the runtime component re-evaluates it on every client-side navigation) as well
 * as on the server, so it may not import Prisma, `server-only`, or anything from
 * `next/`.
 *
 * ## Two independent gates, and why one would not be enough
 *
 * 1. **{@link isFixedNonceWebsitePath} must say yes.** That predicate is derived
 *    from the real route tree (`src/lib/public-website-paths.ts`, kept exhaustive
 *    by `setup-gate.test.ts` walking `src/app`), and it answers "is this an address
 *    one of the five approved `(website)` routes serves". Every excluded class the
 *    owner listed falls out of it already: `/admin/*`, every authenticated member
 *    and dashboard route, and — because each is a `NON_WEBSITE_ROOT_SEGMENTS`
 *    entry — `/login`, `/register`, `/forgot-password`, `/reset-password`,
 *    `/change-password`, `/verify-email`, `/confirm-email-change`,
 *    `/family-invite/*`, `/membership-cancellation/*`, `/pay/*`, `/chores/*`,
 *    `/booking-requests/*` and `/school-bookings/*`. It also subtracts the three
 *    `(website-dynamic)` pages, which are exactly the PIN-bearing and
 *    token-bearing public pages (`/hut-leader-instructions`, `/join/[code]`,
 *    `/join/verify/[token]`).
 *
 *    Using it means a route added to any of those groups later is excluded the day
 *    it is added, with no second list to remember. That is the failure mode a
 *    hand-written denylist has: it rots silently, in the dangerous direction.
 *
 * 2. **The address must also LOOK like an ordinary public page.** Gate 1 admits
 *    everything the `[...slug]` CMS catch-all claims, which is every URL no other
 *    route matches — including addresses that carry an opaque identifier
 *    (`/reset/AbCdEf0123456789xyz`), a percent-encoded segment, or a
 *    credential-flavoured word. None of those is a real CMS page: an
 *    admin-authored slug matches {@link CMS_SEGMENT_PATTERN} (the same shape
 *    `isValidPageSlug` enforces on write). So gate 2 refuses anything that does
 *    not, plus a small set of credential-flavoured segment words, and the result
 *    is fail-CLOSED: an unrecognised shape is excluded rather than tracked.
 *
 * The cost of gate 2 is that a club which names a page `verify-your-booking` gets
 * no analytics on it. That is the right trade in this direction and it is
 * documented in `docs/user-guide` — a missing page view is a reporting gap, a sent
 * token is a disclosure.
 */

/**
 * One segment of an admin-authored CMS slug, mirroring `PAGE_SLUG_PATTERN` in
 * `src/lib/page-content.ts` (lowercase alphanumerics in hyphen-joined words).
 *
 * Anything else — uppercase, underscores, dots, percent escapes, mixed-case
 * identifiers, long random strings — is not a slug an admin could have created,
 * so it is not an address analytics runs on.
 */
const CMS_SEGMENT_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A slug segment longer than this is an identifier, not a title. */
const MAX_CMS_SEGMENT_LENGTH = 60;

/**
 * An OPAQUE IDENTIFIER shaped like a slug: one unbroken run of lowercase letters and
 * digits, long enough to be a token rather than a word.
 *
 * {@link CMS_SEGMENT_PATTERN} alone does not catch these, and that is a real gap
 * rather than a theoretical one: `/t/9f8e7d6c5b4a39281706` and
 * `/cm5x9q2ab000108l3f4g5h6i` are both valid lowercase-alphanumeric segments, so the
 * pattern admits them — and if a link of either shape ever exists in the wild, the
 * catch-all serves its 404 and the address would have been reported to Google with
 * the identifier intact. A lowercase hex token, a cuid and a base32 code are all
 * exactly this shape.
 *
 * The three conditions together are what keep real page titles out of it:
 *  • **no hyphen** — an admin-authored slug is hyphen-joined words
 *    (`annual-general-meeting`, `trips-2026`), so any hyphen exempts the segment;
 *  • **at least 12 characters** — `contact`, `join`, `lodges`, `2026` are shorter;
 *  • **letters AND digits mixed** — `newsletter`, `accommodation` and
 *    `membership` carry no digit, and `2026` carries no letter.
 *
 * The residue is a page whose slug is one long unhyphenated word containing a digit
 * (`newsletter2026`), which loses its page views. That is the trade this module makes
 * everywhere and it is stated in the header: a missing page view is a reporting gap,
 * a sent token is a disclosure.
 */
const OPAQUE_IDENTIFIER_MIN_LENGTH = 12;

function looksLikeOpaqueIdentifier(segment: string): boolean {
  if (segment.includes("-")) {
    return false;
  }
  if (segment.length < OPAQUE_IDENTIFIER_MIN_LENGTH) {
    return false;
  }
  return /[a-z]/.test(segment) && /[0-9]/.test(segment);
}

/** More segments than this is not a page hierarchy an admin authored. */
const MAX_CMS_SEGMENTS = 4;

/**
 * Segment words that mark a credential, recovery or callback flow.
 *
 * Every one of these is ALREADY excluded by gate 1 at its real address; this list
 * is the belt to that braces, and it covers the addresses gate 1 admits because
 * nothing claims them — the catch-all's territory. `/verify/abc123` is not a route
 * today, so gate 1 says yes; a future release that adds one would be excluded by
 * gate 1 too, but until then a link of that shape in the wild must not be tracked.
 *
 * Matched case-insensitively against WHOLE segments only, so `overview`,
 * `verification-of-membership` and `pinnacle-ridge` are unaffected.
 */
const CREDENTIAL_SEGMENT_WORDS: ReadonlySet<string> = new Set([
  "activate",
  "auth",
  "callback",
  "callbacks",
  "code",
  "codes",
  "confirm",
  "invitation",
  "invitations",
  "invite",
  "invites",
  "magic",
  "oauth",
  "otp",
  "pin",
  "pins",
  "recover",
  "recovery",
  "reset",
  "return",
  "secret",
  "session",
  "token",
  "tokens",
  "verification",
  "verify",
]);

/** One trailing slash off. Matches how the route census normalises. */
function normalisePathname(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

/**
 * May Google Analytics load, and may a page view be sent, for this pathname?
 *
 * Takes a PATHNAME only — never a full URL, never a search string. The caller
 * passes `usePathname()` (which is already query-free and fragment-free), and a
 * value that does carry `?` or `#` is refused rather than parsed, because a caller
 * handing this a full URL is a caller that would also have handed it to Google.
 */
export function isAnalyticsEligiblePath(pathname: string): boolean {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) {
    return false;
  }
  // A pathname carrying either of these is not a pathname. Fail closed rather
  // than stripping: the stripped remainder might be eligible and the caller's bug
  // would go unnoticed.
  if (pathname.includes("?") || pathname.includes("#")) {
    return false;
  }

  const path = normalisePathname(pathname);

  // Gate 1: the address must be served by one of the five approved public routes.
  if (!isFixedNonceWebsitePath(path)) {
    return false;
  }

  if (path === "/") {
    return true;
  }

  // Gate 2: and it must look like an ordinary public page.
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.length > MAX_CMS_SEGMENTS) {
    return false;
  }

  return segments.every(
    (segment) =>
      segment.length <= MAX_CMS_SEGMENT_LENGTH &&
      CMS_SEGMENT_PATTERN.test(segment) &&
      !CREDENTIAL_SEGMENT_WORDS.has(segment.toLowerCase()) &&
      !looksLikeOpaqueIdentifier(segment),
  );
}

/**
 * The ONLY page-location value that may be sent to Google: `origin` + `pathname`.
 *
 * No query string, no fragment, no credentials, no identifiers — section 7's list
 * is enforced by construction here rather than by filtering, because a filter has
 * to anticipate the parameter names and this does not. Returns `null` for an
 * ineligible path, so a caller that forgets to check eligibility separately still
 * cannot send one.
 *
 * `origin` is passed in rather than read from `window` so this is testable and so
 * the server can compute the same answer.
 */
export function buildAnalyticsPageLocation(
  origin: string,
  pathname: string,
): string | null {
  if (!isAnalyticsEligiblePath(pathname)) {
    return null;
  }
  return `${origin.replace(/\/+$/, "")}${normalisePathname(pathname)}`;
}

/**
 * Sanitise a document referrer before Google is allowed to see it.
 *
 * gtag sends `document.referrer` automatically, and leaving it alone is a real
 * leak rather than a theoretical one: a visitor who lands on `/pay/<token>` and
 * then clicks through to the public site would have handed Google the payment
 * token in the referrer of the FIRST eligible page view. Overriding
 * `page_referrer` with this value is what closes it.
 *
 * The rules, tightest-first:
 *  • no referrer, or an unparseable one — send nothing (`null`), which makes gtag
 *    omit the field rather than fall back to the raw value;
 *  • SAME-ORIGIN referrer whose path is analytics-eligible — origin + pathname,
 *    the same sanitisation the page location gets;
 *  • SAME-ORIGIN referrer whose path is NOT eligible (an admin page, a token
 *    page, a member dashboard) — the ORIGIN only. That the visitor came from
 *    somewhere on this site is not sensitive; which excluded page is;
 *  • CROSS-ORIGIN referrer — the origin only. A search engine's or partner's URL
 *    can carry identifiers of its own, and the referring site is all the analytics
 *    value there is.
 */
export function sanitiseAnalyticsReferrer(
  referrer: string | null | undefined,
  currentOrigin: string,
): string | null {
  if (!referrer) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(referrer);
  } catch {
    return null;
  }

  if (url.origin !== currentOrigin) {
    return url.origin;
  }

  return buildAnalyticsPageLocation(url.origin, url.pathname) ?? url.origin;
}
