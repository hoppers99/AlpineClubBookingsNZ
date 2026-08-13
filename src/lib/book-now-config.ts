import "server-only";

import { buildBookingLoginPath } from "@/lib/auth-redirect";
import { DEFAULT_PUBLIC_CONTENT_SETTINGS } from "@/config/club-settings-defaults";
import { prisma } from "@/lib/prisma";
import { isReservedPageSlug } from "@/lib/page-content";
import { isCmsServablePageSlug } from "@/lib/public-website-paths";
// The warm-up gate's planner owns this shape and is deliberately pure, so the type
// lives there and is imported here rather than the other way round (#2566).
import type { ConfiguredBookNowTarget } from "@/lib/deploy/warmup-route-policy";

/**
 * Resolved public "Book Now" button state (E3 #1929).
 *  - `show: false` — the admin hid the button; render nothing.
 *  - `show: true` — render the button pointing at `href`, labelled `label`.
 *
 * FAIL-OPEN contract: anything other than a hidden button or a PAGE target that
 * resolves to a PUBLISHED page (missing FK, unpublished page, DB error) falls
 * back to the default booking flow, so the button is never dead.
 */
export interface BookNowConfig {
  show: boolean;
  href: string;
  label: string;
}

/** The label a SIGNED-IN member sees: they really can book, in one click. */
export const MEMBER_BOOK_NOW_LABEL = "Book Now";

/**
 * The label a SIGNED-OUT visitor sees (#2430, owner decision 1 Aug 2026).
 *
 * "Book Now" on a public page reads as walk-in commercial accommodation, which
 * this club is not: there is no public booking to press. Whatever the button
 * points at, an anonymous visitor cannot book from it — the BOOKING_FLOW target
 * sends them to the MEMBER login (`buildBookingLoginPath`), and a PAGE target
 * sends them to a content page that is, at best, an explanation of how member
 * booking works. Naming the audience up front is the whole point: the button
 * says who it is for before it is pressed rather than after.
 *
 * ONE label across desktop and mobile, deliberately. The longer
 * "Members: book a stay" fits the full-width mobile drawer button but not the
 * `size="sm"` desktop header CTA sitting beside "Log In" in an `h-16` bar, and
 * one CTA that renames itself between viewports is worse than the shorter form
 * everywhere.
 *
 * The split is by SESSION only, not by target: an admin who points the button
 * at a content page still gets this label for anonymous visitors, because the
 * visitor's position — not the destination — is what the wording is about.
 */
export const ANONYMOUS_BOOK_NOW_LABEL = "Member booking";

/**
 * The parts of the resolved button that do NOT depend on the visitor: whether the
 * admin shows it at all, and the content-page target if they chose one.
 *
 * Split out for #2352 D2. The public header is now one stored copy served to
 * everyone, so it needs BOTH the signed-out and signed-in forms of the button —
 * and it must not pay two database reads to get them. Everything session-specific
 * is a pure function of this plus one boolean (see `bookNowVariant`), so the two
 * forms can never disagree about the admin's choice.
 */
interface BookNowChoice {
  show: boolean;
  /** The admin's PAGE target, or null for the default booking flow. */
  pageHref: string | null;
  /**
   * Set when the settings read FAILED and this value is the fail-open default rather
   * than the club's choice.
   *
   * The button itself does not care — #1929 requires it to be live either way, which
   * is what the catch below delivers. It exists for the #2566 warm-up gate, whose
   * answer to "is there a public booking entry page?" must not be the confident "no"
   * that a swallowed database error otherwise produces. When it is set, `pageHref`
   * carries no information at all.
   */
  readFailed: boolean;
  /** Why the read failed, for the caller that reports it. */
  readFailureDetail: string | null;
}

function bookNowVariant(
  isAuthenticated: boolean,
  { pageHref }: BookNowChoice,
): Omit<BookNowConfig, "show"> {
  // Default flow: a logged-in member books directly; a guest goes via login.
  const defaultHref = isAuthenticated ? "/book" : buildBookingLoginPath();

  return {
    href: pageHref ?? defaultHref,
    label: isAuthenticated ? MEMBER_BOOK_NOW_LABEL : ANONYMOUS_BOOK_NOW_LABEL,
  };
}

async function resolveBookNowChoice(): Promise<BookNowChoice> {
  try {
    const settings = await prisma.publicContentSettings.findUnique({
      where: { id: "default" },
      select: {
        showBookNow: true,
        bookNowTarget: true,
        bookNowPage: { select: { slug: true, path: true, published: true } },
      },
    });

    // No row yet: the club has never chosen, so the button follows the shipped
    // default — OFF since #2430, so a fresh install advertises no public
    // booking CTA at all. That value is the same portable one config transfer
    // exports for an unsaved singleton (#2200), sourced from one constant so
    // the two cannot drift. A club that HAS saved a value is read from the row
    // below, saved-true and saved-false alike — the one-off backfill in
    // 20260802100000_public_book_now_default_off is what set every existing
    // club's stored value to false at upgrade (owner decision on PR #2466),
    // not this branch.
    if (!settings)
      return {
        show: DEFAULT_PUBLIC_CONTENT_SETTINGS.showBookNow,
        pageHref: null,
        readFailed: false,
        readFailureDetail: null,
      };

    if (!settings.showBookNow)
      return {
        show: false,
        pageHref: null,
        readFailed: false,
        readFailureDetail: null,
      };

    // The servability check is the #2352 slice-1 half (added by that slice's
    // security review). Slice 1 reserved every first segment belonging to another
    // route group, so a page at `/lodge/booking-info` — a legal target when it was
    // chosen — is no longer served by the catch-all. The row is untouched and still
    // published, so without this the button would point every visitor at a 404.
    // Treating it as a dead target is exactly the case #1929's fail-open contract
    // already covers, alongside a deleted or unpublished page.
    //
    // `!isReservedPageSlug` extends that to reserved WORDS in a non-leading
    // segment (#2818): `isCmsServablePageSlug` asks the route-group question of
    // the first segment only, so it accepts `/trips/booking-requests`, but the
    // catch-all loader hard-404s any slug containing the `booking-requests` /
    // `school-bookings` reserved words — so the button would otherwise point at a
    // 404 there too.
    if (
      settings.bookNowTarget === "PAGE" &&
      settings.bookNowPage?.published &&
      settings.bookNowPage.path &&
      isCmsServablePageSlug(settings.bookNowPage.slug) &&
      !isReservedPageSlug(settings.bookNowPage.slug)
    ) {
      return {
        show: true,
        pageHref: settings.bookNowPage.path,
        readFailed: false,
        readFailureDetail: null,
      };
    }

    // BOOKING_FLOW, or a PAGE target whose page is missing, unpublished or at an
    // address the public website no longer serves: fail open.
    return {
      show: true,
      pageHref: null,
      readFailed: false,
      readFailureDetail: null,
    };
  } catch (error) {
    // Deliberately still FAIL-OPEN, and deliberately out of step with the
    // no-row branch above, which fails closed since #2430: a database error is
    // not a club's choice, and #1929 owns the "the button is never dead"
    // contract this line implements. So a club whose button is off can, for the
    // life of a database outage, show it — narrow the contract only with the
    // owner's decision on #1929, not as a side effect of a default flip.
    //
    // `readFailed` is what stops that fail-open from being read as a club's answer by
    // a caller for which the difference matters. The button ignores it.
    return {
      show: true,
      pageHref: null,
      readFailed: true,
      readFailureDetail:
        error instanceof Error ? error.message : "unknown database error",
    };
  }
}

/**
 * Both forms of the button from ONE read, for the public header (#2352 D2).
 *
 * `show` is deliberately shared: whether the button exists is the admin's choice
 * and never the visitor's, so it is settled on the server and cannot flicker in
 * the browser.
 */
export async function getBookNowVariants(): Promise<{
  show: boolean;
  anonymous: Omit<BookNowConfig, "show">;
  member: Omit<BookNowConfig, "show">;
}> {
  const choice = await resolveBookNowChoice();

  return {
    show: choice.show,
    anonymous: bookNowVariant(false, choice),
    member: bookNowVariant(true, choice),
  };
}

/**
 * The club's configured public booking entry page, or null when there is not one.
 *
 * For the pre-cutover warm-up gate (#2566). The owner's critical-route list names
 * "any public booking entry route", and in this deployment that is either a CMS
 * content page an admin pointed the Book Now button at, or nothing public at all:
 * on the default `BOOKING_FLOW` target an anonymous visitor is sent to the member
 * login path, which the same decision excludes from warming, and `/book` is
 * authenticated.
 *
 * Reads through the one resolver above rather than querying again, so it inherits
 * every rule the button itself obeys — the hidden-button case, the #1929 fail-open
 * contract, and the #2352 servability check that refuses a target the public
 * website no longer serves. A `none` here therefore means "no public booking page to
 * warm", never "there is one but this function disagrees with the button".
 *
 * Three states rather than `string | null`, and that is the whole point of this
 * signature. The resolver fails OPEN on a database error, so a failed read of
 * `PublicContentSettings` produced the same `null` as a deliberately hidden button —
 * and the gate then printed "Nothing public is missing" about a critical public route
 * it had never established the existence of. `unreadable` is that case, named.
 */
export async function getConfiguredBookNowPagePath(): Promise<ConfiguredBookNowTarget> {
  const choice = await resolveBookNowChoice();

  if (choice.readFailed) {
    return {
      state: "unreadable",
      detail:
        choice.readFailureDetail ?? "the Book Now setting could not be read",
    };
  }

  if (!choice.show || choice.pageHref === null) {
    return { state: "none" };
  }

  return { state: "page", path: choice.pageHref };
}
