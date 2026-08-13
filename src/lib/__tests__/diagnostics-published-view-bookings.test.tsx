/**
 * THE BOOKINGS LIST PUBLISHES WHAT IT APPLIED, NOT WHAT THE ADDRESS SAYS
 * (#2816, owner decision 13 Aug 2026).
 *
 * This page is the reason the address bar was rejected as the channel:
 * `adminBookingsQuerySchema.safeParse` is TOTAL, so one malformed value drops the
 * ENTIRE filter set back to defaults while the URL still displays every filter.
 * A view read from the address would then tell the model the operator had
 * narrowed a list they are in fact seeing unfiltered.
 *
 * The assertions read the `view` prop the page hands `DiagnosticsViewStatePublisher`
 * rather than rendering it: the publisher renders null by design, and its effect
 * belongs to the client. What is under test here is the page's DERIVATION.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findMany: vi.fn(), count: vi.fn() },
    bookingGuest: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    hostingCoverageIncident: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    xeroSyncOperation: { findMany: vi.fn() },
    xeroObjectLink: { findMany: vi.fn() },
    lodge: {
      findMany: vi.fn().mockResolvedValue([{ id: "lodge-1", name: "Lodge" }]),
    },
  },
}));

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/components/admin/booking-filters", () => ({
  BookingFilters: () => null,
}));
vi.mock("@/components/admin-booking-calendar", () => ({
  AdminBookingCalendar: () => null,
}));
vi.mock("@/lib/module-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/module-settings")>();
  return {
    ...actual,
    loadEffectiveModuleFlags: vi.fn(),
  };
});

import AdminBookingsPage from "@/app/(admin)/admin/bookings/page";
import { DiagnosticsViewStatePublisher } from "@/components/help-widget/diagnostics-view-state-publisher";
import type { DiagnosticsViewState } from "@/components/help-widget/help-widget-context";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

const MODULES_OFF = {
  kiosk: false,
  chores: false,
  financeDashboard: false,
  waitlist: false,
  xeroIntegration: false,
  bedAllocation: false,
  internetBankingPayments: false,
  addressAutocomplete: false,
  groupBookings: false,
  lockers: false,
  induction: false,
  workParties: false,
  promoCodes: false,
  hutLeaders: false,
  communications: false,
  skifieldConditions: false,
  twoFactor: false,
  magicLink: false,
  googleLogin: false,
  analytics: false,
  lobbyDisplay: false,
  aiAssistant: false,
  memberNotices: false,
  eventsCalendar: false,
  memberGuests: false,
  aiDiagnostics: true,
};

/** Depth-first walk for the publisher element, wherever the page puts it. */
function findPublishedView(node: ReactNode): DiagnosticsViewState | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findPublishedView(child);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  const element = node as ReactElement<Record<string, unknown>>;
  if (element.type === DiagnosticsViewStatePublisher) {
    return element.props.view as DiagnosticsViewState;
  }
  return findPublishedView(element.props.children as ReactNode);
}

async function publishedViewFor(
  searchParams: Record<string, string>,
): Promise<DiagnosticsViewState | undefined> {
  const tree = await AdminBookingsPage({
    searchParams: Promise.resolve(searchParams),
  });
  return findPublishedView(tree);
}

describe("the bookings list publishes its APPLIED filters (#2816)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadEffectiveModuleFlags).mockResolvedValue(MODULES_OFF);
    vi.mocked(prisma.booking.findMany).mockResolvedValue([]);
    vi.mocked(prisma.booking.count).mockResolvedValue(0);
    vi.mocked(prisma.hostingCoverageIncident.count).mockResolvedValue(0);
    vi.mocked(prisma.hostingCoverageIncident.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroSyncOperation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.xeroObjectLink.findMany).mockResolvedValue([]);
    vi.mocked(auth).mockResolvedValue({
      user: { id: "admin-1", accessRoles: [{ role: "ADMIN" }] },
    } as never);
  });

  it("publishes the status, window and search a well-formed address applied", async () => {
    expect(
      await publishedViewFor({
        status: "CONFIRMED",
        from: "2026-08-01",
        to: "2026-08-31",
        search: "  ngata  ",
        lodgeId: "lodge-1",
        page: "3",
      }),
    ).toEqual({
      status: "CONFIRMED",
      filters: {
        from: "2026-08-01",
        to: "2026-08-31",
        // Post-trim, because the trim is what the query used.
        search: "ngata",
        lodgeId: "lodge-1",
      },
      // `page` is pagination: not in the row's allowlist, and it says nothing
      // about why the page shows what it shows.
    });
  });

  it("PUBLISHES NOTHING when one malformed value made the parse drop every filter", async () => {
    // The whole reason this channel exists. `from` is not a date, the total
    // parse fails, and `adminBookingsQuerySchema.parse({})` replaces the lot —
    // so the list on screen is unfiltered even though the address shows a
    // status, a window and a search.
    const view = await publishedViewFor({
      status: "CONFIRMED",
      from: "13-45-2026",
      to: "2026-08-31",
      search: "ngata",
    });
    expect(view).toEqual({});

    // And the page really did apply nothing: the query is the default one.
    const where = vi.mocked(prisma.booking.findMany).mock
      .calls[0][0] as unknown as { where: Record<string, unknown> };
    expect(where.where.checkIn).toBeUndefined();
    expect(where.where.checkOut).toBeUndefined();
  });

  it("publishes `{}` rather than undefined, so the widget cannot fall back to the address", async () => {
    // `{}` is "I applied nothing" and suppresses the URL fallback; `undefined`
    // would be "I publish nothing" and invite it — straight back to the address
    // this page has just refused.
    expect(await publishedViewFor({ from: "13-45-2026" })).not.toBeUndefined();
  });

  it("does not publish a legacy `from`/`to` that lost to an explicit named bound", async () => {
    // `checkInFrom ?? from`, and `to` yields to either `checkInTo` or
    // `checkOutTo`. An alias that lost is in the address and not in the query.
    expect(
      await publishedViewFor({
        from: "2026-08-01",
        checkInFrom: "2026-09-01",
        to: "2026-08-31",
        checkInTo: "2026-09-30",
      }),
    ).toEqual({});
  });

  it("publishes several applied statuses as the allowlisted filter, not as one token", async () => {
    // The wire's `status` holds ONE token; silently sending the first would
    // misstate a two-status selection.
    expect(
      await publishedViewFor({ status: "CONFIRMED,PAID" }),
    ).toEqual({ filters: { status: "CONFIRMED,PAID" } });
  });

  it("publishes no status for one that is not a real booking status", async () => {
    // `?status=BOGUS` applies `{ in: [] }` — a narrowing that matches nothing —
    // and there is no honest way to say that in this vocabulary.
    expect(await publishedViewFor({ status: "BOGUS" })).toEqual({});
  });

  it("publishes nothing while the consent ATTENTION queue has replaced the table", async () => {
    // That queue renders `listMemberGuestConsentExceptions()`, which takes no
    // filter arguments at all — nothing on screen is filtered by these values.
    expect(
      await publishedViewFor({ consentState: "attention", status: "CONFIRMED" }),
    ).toEqual({});
  });
});
