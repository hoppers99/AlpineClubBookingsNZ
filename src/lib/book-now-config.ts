import "server-only";

import { buildBookingLoginPath } from "@/lib/auth-redirect";
import { DEFAULT_PUBLIC_CONTENT_SETTINGS } from "@/config/club-settings-defaults";
import { prisma } from "@/lib/prisma";

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

export async function getBookNowConfig(
  isAuthenticated: boolean,
): Promise<BookNowConfig> {
  // Default flow: a logged-in member books directly; a guest goes via login.
  const defaultHref = isAuthenticated ? "/book" : buildBookingLoginPath();
  const label = isAuthenticated
    ? MEMBER_BOOK_NOW_LABEL
    : ANONYMOUS_BOOK_NOW_LABEL;

  try {
    const settings = await prisma.publicContentSettings.findUnique({
      where: { id: "default" },
      select: {
        showBookNow: true,
        bookNowTarget: true,
        bookNowPage: { select: { path: true, published: true } },
      },
    });

    // No row yet: the club has never chosen, so the button follows the shipped
    // default — OFF since #2430, so a fresh install advertises no public
    // booking CTA at all. That value is the same portable one config transfer
    // exports for an unsaved singleton (#2200), sourced from one constant so
    // the two cannot drift. A club that HAS saved its choice is unaffected:
    // the row wins below, saved-true and saved-false alike.
    if (!settings)
      return {
        show: DEFAULT_PUBLIC_CONTENT_SETTINGS.showBookNow,
        href: defaultHref,
        label,
      };

    if (!settings.showBookNow) return { show: false, href: defaultHref, label };

    if (
      settings.bookNowTarget === "PAGE" &&
      settings.bookNowPage?.published &&
      settings.bookNowPage.path
    ) {
      return { show: true, href: settings.bookNowPage.path, label };
    }

    // BOOKING_FLOW, or a PAGE target whose page is missing/unpublished: fail open.
    return { show: true, href: defaultHref, label };
  } catch {
    return { show: true, href: defaultHref, label };
  }
}
