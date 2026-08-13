import { beforeEach, describe, expect, it, vi } from "vitest";

// Neutralise the client-boundary guard so the server-only module imports in node.
vi.mock("server-only", () => ({}));

vi.mock("@/lib/prisma", () => ({
  prisma: { publicContentSettings: { findUnique: vi.fn() } },
}));
vi.mock("@/lib/auth-redirect", () => ({
  buildBookingLoginPath: () => "/login?next=/book",
}));

import { DEFAULT_PUBLIC_CONTENT_SETTINGS } from "@/config/club-settings-defaults";
import { prisma } from "@/lib/prisma";
import {
  ANONYMOUS_BOOK_NOW_LABEL,
  MEMBER_BOOK_NOW_LABEL,
  getBookNowVariants,
  getConfiguredBookNowPagePath,
} from "@/lib/book-now-config";

/**
 * The per-visitor form of the button, as the header used to ask for it.
 *
 * #2352 D2 replaced the old `getBookNowConfig(isAuthenticated)` with
 * `getBookNowVariants()`, which resolves BOTH forms from one database read
 * because the public header is now a single stored copy served to everyone. The
 * whole fail-open matrix below is unchanged and still asserted per visitor state;
 * this helper is just the shape adapter.
 */
async function bookNowFor(isAuthenticated: boolean) {
  const variants = await getBookNowVariants();
  return {
    show: variants.show,
    ...(isAuthenticated ? variants.member : variants.anonymous),
  };
}

const findUnique = (
  prisma.publicContentSettings as unknown as { findUnique: ReturnType<typeof vi.fn> }
).findUnique;

describe("getBookNowVariants fail-open matrix (E3 #1929)", () => {
  beforeEach(() => vi.clearAllMocks());

  // #2430: a club that has never saved the singleton now gets the shipped
  // default, which is OFF — no public booking CTA on a fresh install.
  it("follows the shipped default when no settings row exists", async () => {
    findUnique.mockResolvedValue(null);
    expect(await bookNowFor(true)).toEqual({
      show: false,
      href: "/book",
      label: MEMBER_BOOK_NOW_LABEL,
    });
    expect(await bookNowFor(false)).toEqual({
      show: false,
      href: "/login?next=/book",
      label: ANONYMOUS_BOOK_NOW_LABEL,
    });
    expect(DEFAULT_PUBLIC_CONTENT_SETTINGS.showBookNow).toBe(false);
  });

  // A stored row still wins at READ time, saved-true and saved-false alike —
  // the reader never second-guesses the column.
  //
  // What this no longer means, deliberately: the owner REVERSED the "existing
  // clubs keep their saved choice" half of #2430 on PR #2466 (1 Aug 2026). The
  // migration 20260802100000_public_book_now_default_off now writes
  // showBookNow = false over every existing row, so a club that had ticked the
  // box is switched off at upgrade and has to tick it again. That happens in
  // SQL, not here; this assertion is the guarantee that once the column says
  // true again, the button comes back.
  it("keeps a saved-true club's button shown", async () => {
    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "BOOKING_FLOW",
      bookNowPage: null,
    });
    expect(await bookNowFor(true)).toEqual({
      show: true,
      href: "/book",
      label: MEMBER_BOOK_NOW_LABEL,
    });
    expect(await bookNowFor(false)).toEqual({
      show: true,
      href: "/login?next=/book",
      label: ANONYMOUS_BOOK_NOW_LABEL,
    });
  });

  it("hides the button when showBookNow is false", async () => {
    findUnique.mockResolvedValue({ showBookNow: false, bookNowTarget: "BOOKING_FLOW", bookNowPage: null });
    expect(await bookNowFor(true)).toEqual({
      show: false,
      href: "/book",
      label: MEMBER_BOOK_NOW_LABEL,
    });
  });

  it("targets a published page's path", async () => {
    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "PAGE",
      bookNowPage: { slug: "how-to-book", path: "/how-to-book", published: true },
    });
    expect(await bookNowFor(true)).toEqual({
      show: true,
      href: "/how-to-book",
      label: MEMBER_BOOK_NOW_LABEL,
    });
    // The label follows the SESSION, not the destination: an anonymous visitor
    // is still an anonymous visitor on an admin-chosen page (#2430).
    expect(await bookNowFor(false)).toEqual({
      show: true,
      href: "/how-to-book",
      label: ANONYMOUS_BOOK_NOW_LABEL,
    });
  });

  it("fails open when the PAGE target is unpublished", async () => {
    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "PAGE",
      bookNowPage: { slug: "how-to-book", path: "/how-to-book", published: false },
    });
    expect(await bookNowFor(true)).toEqual({
      show: true,
      href: "/book",
      label: MEMBER_BOOK_NOW_LABEL,
    });
  });

  // #2352 slice-1 review. The slice reserved every first segment owned by another
  // route group, so a target chosen before that rule existed can still be
  // published while the catch-all no longer serves it. Pointing the public button
  // at a 404 is worse than the default booking flow, and this is the same dead
  // target #1929's contract already fails open for.
  it("fails open when the PAGE target sits under a reserved prefix", async () => {
    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "PAGE",
      bookNowPage: {
        slug: "lodge/booking-info",
        path: "/lodge/booking-info",
        published: true,
      },
    });
    expect(await bookNowFor(true)).toEqual({
      show: true,
      href: "/book",
      label: MEMBER_BOOK_NOW_LABEL,
    });
    expect(await bookNowFor(false)).toEqual({
      show: true,
      href: "/login?next=/book",
      label: ANONYMOUS_BOOK_NOW_LABEL,
    });
  });

  // #2818: the reserved-WORD hazard, one segment deeper than the slice-1 rule.
  // `/trips/booking-requests` passes the route-group servability check
  // (`isCmsServablePageSlug` looks at the first segment only), but the catch-all
  // loader hard-404s any slug containing the `booking-requests`/`school-bookings`
  // reserved words — so the button must fail open here exactly as it does for a
  // reserved first segment.
  it.each(["trips/booking-requests", "info/school-bookings"])(
    "fails open when the PAGE target contains a reserved word (%s)",
    async (slug) => {
      findUnique.mockResolvedValue({
        showBookNow: true,
        bookNowTarget: "PAGE",
        bookNowPage: {
          slug,
          path: `/${slug}`,
          published: true,
        },
      });
      expect(await bookNowFor(false)).toEqual({
        show: true,
        href: "/login?next=/book",
        label: ANONYMOUS_BOOK_NOW_LABEL,
      });
    },
  );

  it("fails open when the PAGE target FK is null", async () => {
    findUnique.mockResolvedValue({ showBookNow: true, bookNowTarget: "PAGE", bookNowPage: null });
    expect(await bookNowFor(false)).toEqual({
      show: true,
      href: "/login?next=/book",
      label: ANONYMOUS_BOOK_NOW_LABEL,
    });
  });

  it("fails open when the DB read throws", async () => {
    findUnique.mockRejectedValue(new Error("db down"));
    expect(await bookNowFor(true)).toEqual({
      show: true,
      href: "/book",
      label: MEMBER_BOOK_NOW_LABEL,
    });
  });
});

// ---------------------------------------------------------------------------
// #2430 (A) — the public CTA never invites a walk-in booking.
// ---------------------------------------------------------------------------
describe("public Book Now CTA label (#2430)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("names the audience for a signed-out visitor and keeps 'Book Now' for a member", async () => {
    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "BOOKING_FLOW",
      bookNowPage: null,
    });

    expect((await bookNowFor(false)).label).toBe("Member booking");
    expect((await bookNowFor(true)).label).toBe("Book Now");
  });

  it("never offers 'Book Now' to an anonymous visitor on any resolved state", async () => {
    const states = [
      null,
      { showBookNow: true, bookNowTarget: "BOOKING_FLOW", bookNowPage: null },
      { showBookNow: false, bookNowTarget: "BOOKING_FLOW", bookNowPage: null },
      {
        showBookNow: true,
        bookNowTarget: "PAGE",
        bookNowPage: { slug: "how-to-book", path: "/how-to-book", published: true },
      },
    ];

    for (const state of states) {
      findUnique.mockResolvedValue(state);
      expect((await bookNowFor(false)).label).not.toBe(
        MEMBER_BOOK_NOW_LABEL,
      );
    }
  });
});

// #2352 D2: the point of resolving both forms together is ONE database read. Two
// reads would have doubled the cost of the header on every public page, which is
// the opposite of what this issue is for, and would let the two forms disagree if
// an admin saved between them.
describe("getBookNowVariants resolves both forms from one read (#2352 D2)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads PublicContentSettings exactly once", async () => {
    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "BOOKING_FLOW",
      bookNowPage: null,
    });

    const variants = await getBookNowVariants();

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(variants.anonymous.label).toBe(ANONYMOUS_BOOK_NOW_LABEL);
    expect(variants.member.label).toBe(MEMBER_BOOK_NOW_LABEL);
    // `show` is the ADMIN's choice, so it is shared rather than per-visitor — the
    // button cannot appear for one visitor and not another.
    expect(variants.show).toBe(true);
  });

  it("gives both forms the SAME admin-chosen page target", async () => {
    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "PAGE",
      bookNowPage: {
        slug: "how-booking-works",
        path: "/how-booking-works",
        published: true,
      },
    });

    const variants = await getBookNowVariants();

    expect(variants.anonymous.href).toBe("/how-booking-works");
    expect(variants.member.href).toBe("/how-booking-works");
  });
});

/**
 * The warm-up gate's reader (#2566), which needs a distinction the button does not.
 *
 * `resolveBookNowChoice()` fails OPEN on a database error, so a failed read of
 * `PublicContentSettings` used to arrive at every caller as "this club has no page
 * target". For the button that is correct and required (#1929: it is never dead). For
 * the pre-cutover gate it was a misreport: it printed "Nothing public is missing" about
 * a critical public route it had never established the existence of.
 */
describe("getConfiguredBookNowPagePath tells a failed read from no target", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the configured page", async () => {
    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "PAGE",
      bookNowPage: {
        slug: "how-booking-works",
        path: "/how-booking-works",
        published: true,
      },
    });

    await expect(getConfiguredBookNowPagePath()).resolves.toEqual({
      state: "page",
      path: "/how-booking-works",
    });
  });

  it("returns none for a hidden button and for the default booking flow", async () => {
    findUnique.mockResolvedValue({
      showBookNow: false,
      bookNowTarget: "PAGE",
      bookNowPage: {
        slug: "how-booking-works",
        path: "/how-booking-works",
        published: true,
      },
    });
    await expect(getConfiguredBookNowPagePath()).resolves.toEqual({
      state: "none",
    });

    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "BOOKING_FLOW",
      bookNowPage: null,
    });
    await expect(getConfiguredBookNowPagePath()).resolves.toEqual({
      state: "none",
    });
  });

  it("returns none for an unpublished page target, which is a real answer", async () => {
    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "PAGE",
      bookNowPage: {
        slug: "how-booking-works",
        path: "/how-booking-works",
        published: false,
      },
    });

    await expect(getConfiguredBookNowPagePath()).resolves.toEqual({
      state: "none",
    });
  });

  it("returns unreadable when the settings read fails, NOT none", async () => {
    findUnique.mockRejectedValue(new Error("statement timeout"));

    await expect(getConfiguredBookNowPagePath()).resolves.toEqual({
      state: "unreadable",
      detail: "statement timeout",
    });
  });

  it("keeps the button live through that same failure", async () => {
    // The #1929 contract is untouched: the fail-open is still a fail-open, and only a
    // caller that asked for the distinction sees it.
    findUnique.mockRejectedValue(new Error("statement timeout"));

    expect(await bookNowFor(false)).toEqual({
      show: true,
      href: "/login?next=/book",
      label: ANONYMOUS_BOOK_NOW_LABEL,
    });
  });
});
