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
  getBookNowConfig,
} from "@/lib/book-now-config";

const findUnique = (
  prisma.publicContentSettings as unknown as { findUnique: ReturnType<typeof vi.fn> }
).findUnique;

describe("getBookNowConfig fail-open matrix (E3 #1929)", () => {
  beforeEach(() => vi.clearAllMocks());

  // #2430: a club that has never saved the singleton now gets the shipped
  // default, which is OFF — no public booking CTA on a fresh install.
  it("follows the shipped default when no settings row exists", async () => {
    findUnique.mockResolvedValue(null);
    expect(await getBookNowConfig(true)).toEqual({
      show: false,
      href: "/book",
      label: MEMBER_BOOK_NOW_LABEL,
    });
    expect(await getBookNowConfig(false)).toEqual({
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
    expect(await getBookNowConfig(true)).toEqual({
      show: true,
      href: "/book",
      label: MEMBER_BOOK_NOW_LABEL,
    });
    expect(await getBookNowConfig(false)).toEqual({
      show: true,
      href: "/login?next=/book",
      label: ANONYMOUS_BOOK_NOW_LABEL,
    });
  });

  it("hides the button when showBookNow is false", async () => {
    findUnique.mockResolvedValue({ showBookNow: false, bookNowTarget: "BOOKING_FLOW", bookNowPage: null });
    expect(await getBookNowConfig(true)).toEqual({
      show: false,
      href: "/book",
      label: MEMBER_BOOK_NOW_LABEL,
    });
  });

  it("targets a published page's path", async () => {
    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "PAGE",
      bookNowPage: { path: "/how-to-book", published: true },
    });
    expect(await getBookNowConfig(true)).toEqual({
      show: true,
      href: "/how-to-book",
      label: MEMBER_BOOK_NOW_LABEL,
    });
    // The label follows the SESSION, not the destination: an anonymous visitor
    // is still an anonymous visitor on an admin-chosen page (#2430).
    expect(await getBookNowConfig(false)).toEqual({
      show: true,
      href: "/how-to-book",
      label: ANONYMOUS_BOOK_NOW_LABEL,
    });
  });

  it("fails open when the PAGE target is unpublished", async () => {
    findUnique.mockResolvedValue({
      showBookNow: true,
      bookNowTarget: "PAGE",
      bookNowPage: { path: "/how-to-book", published: false },
    });
    expect(await getBookNowConfig(true)).toEqual({
      show: true,
      href: "/book",
      label: MEMBER_BOOK_NOW_LABEL,
    });
  });

  it("fails open when the PAGE target FK is null", async () => {
    findUnique.mockResolvedValue({ showBookNow: true, bookNowTarget: "PAGE", bookNowPage: null });
    expect(await getBookNowConfig(false)).toEqual({
      show: true,
      href: "/login?next=/book",
      label: ANONYMOUS_BOOK_NOW_LABEL,
    });
  });

  it("fails open when the DB read throws", async () => {
    findUnique.mockRejectedValue(new Error("db down"));
    expect(await getBookNowConfig(true)).toEqual({
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

    expect((await getBookNowConfig(false)).label).toBe("Member booking");
    expect((await getBookNowConfig(true)).label).toBe("Book Now");
  });

  it("never offers 'Book Now' to an anonymous visitor on any resolved state", async () => {
    const states = [
      null,
      { showBookNow: true, bookNowTarget: "BOOKING_FLOW", bookNowPage: null },
      { showBookNow: false, bookNowTarget: "BOOKING_FLOW", bookNowPage: null },
      {
        showBookNow: true,
        bookNowTarget: "PAGE",
        bookNowPage: { path: "/how-to-book", published: true },
      },
    ];

    for (const state of states) {
      findUnique.mockResolvedValue(state);
      expect((await getBookNowConfig(false)).label).not.toBe(
        MEMBER_BOOK_NOW_LABEL,
      );
    }
  });
});
