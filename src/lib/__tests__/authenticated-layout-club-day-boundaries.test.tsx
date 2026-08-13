/**
 * The staying-guest day boundary in the authenticated layout (#2838).
 *
 * This layout wraps every member page, and the `isStayingGuest` flag it hands
 * the nav bar is what puts the lodge surfaces in front of a guest. Its own
 * comment states the rule — a PAID booking where `checkIn - 1 <= today <=
 * checkOut` — so the day-before access is deliberate, not incidental.
 *
 * `Booking.checkIn`/`checkOut` are `@db.Date`, and `@prisma/adapter-pg` narrows
 * a bound `Date` for such a column to its UTC calendar date (`formatDate` in
 * `mapArg`). The old `new Date()` + `setHours(0, 0, 0, 0)` was NZ-LOCAL
 * midnight, `(D-1)T12:00Z` under the `TZ=Pacific/Auckland` server pin, so it
 * narrowed to D-1 and moved the whole window a day late.
 *
 * The pinned instant is 01:30 on 2 July in New Zealand and 23:30 on 1 July in
 * both UTC and Brisbane, so a wrong club zone changes the answer rather than
 * merely the arithmetic; `expectClubTimeZonePremise()` says so out loud when it
 * does (docs/TESTING.md rule 6).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import { expectClubTimeZonePremise } from "@/lib/__tests__/helpers/club-time-zone";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  headers: vi.fn(),
  memberFindUnique: vi.fn(),
  bookingFindFirst: vi.fn(),
  hasActiveHutLeaderAssignment: vi.fn(),
  navBar: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: () => mocks.auth() }));
vi.mock("next/headers", () => ({ headers: () => mocks.headers() }));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`redirect:${path}`);
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findUnique: mocks.memberFindUnique },
    booking: { findFirst: mocks.bookingFindFirst },
  },
}));
vi.mock("@/lib/hut-leader", () => ({
  hasActiveHutLeaderAssignment: mocks.hasActiveHutLeaderAssignment,
}));
vi.mock("@/lib/club-theme-fonts", () => ({
  clubThemeFontVariableClassName: "font-vars",
}));
vi.mock("@/lib/site-banners", () => ({
  getCurrentSiteBanners: vi.fn(async () => []),
}));
vi.mock("@/lib/club-theme", () => ({
  getWebsiteThemeRenderState: vi.fn(async () => ({ appCss: "" })),
}));
vi.mock("@/lib/public-layout-config", async () => {
  const { clubIdentity } = await import("@/config/club-identity");
  return { getCachedClubIdentity: vi.fn(async () => clubIdentity) };
});
// Partial: `@/config/club-identity` also reads FALLBACK_LODGE_CAPACITY from
// this module at import time, so the real exports have to stay in place.
vi.mock("@/lib/lodge-capacity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDefaultLodgeCapacity: vi.fn(async () => 30),
}));
vi.mock("@/lib/module-settings", () => ({
  loadEffectiveModuleFlags: vi.fn(async () => ({ aiAssistant: false })),
}));
vi.mock("@/lib/ai-assistant-config", () => ({
  getAiAssistantAvailability: vi.fn(async () => false),
}));
vi.mock("@/components/app-providers", () => ({
  AppProviders: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/nav-bar", () => ({
  NavBar: (props: { user: { isStayingGuest: boolean } }) => {
    mocks.navBar(props);
    return null;
  },
}));
vi.mock("@/components/site-banners", () => ({ SiteBanners: () => null }));
vi.mock("@/components/member-onboarding-wizard", () => ({
  MemberOnboardingWizard: () => null,
}));
vi.mock("@/components/report-issue-widget", () => ({
  ReportIssueWidget: () => null,
}));
vi.mock("@/components/help-widget/help-widget-context", () => ({
  HelpWidgetProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/components/help-widget/help-widget-member", () => ({
  HelpWidgetMember: () => null,
}));

import AuthenticatedLayout from "@/app/(authenticated)/layout";

const PINNED_INSTANT = "2026-07-01T13:30:00.000Z";
const CLUB_TODAY = "2026-07-02";

type DateFilter = { gte?: Date; lte?: Date };

/** The calendar day Postgres receives for a value bound to a `@db.Date`. */
function boundDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateFilterAdmits(storedDay: string, filter: DateFilter): boolean {
  if (filter.gte && storedDay < boundDay(filter.gte)) return false;
  if (filter.lte && storedDay > boundDay(filter.lte)) return false;
  return true;
}

function withStay(stay: { checkIn: string; checkOut: string } | null) {
  mocks.bookingFindFirst.mockImplementation(async (args: unknown) => {
    const where = (args as { where: { checkIn: DateFilter; checkOut: DateFilter } })
      .where;
    if (!stay) return null;
    return dateFilterAdmits(stay.checkIn, where.checkIn) &&
      dateFilterAdmits(stay.checkOut, where.checkOut)
      ? { id: "stay-1" }
      : null;
  });
}

async function isStayingGuest(): Promise<boolean> {
  // Rendering (rather than just awaiting the layout) is what runs the NavBar
  // element, and its `user` prop is the flag under test.
  renderToStaticMarkup(await AuthenticatedLayout({ children: "member page" }));
  const call = mocks.navBar.mock.calls.at(-1)?.[0] as {
    user: { isStayingGuest: boolean };
  };
  return call.user.isStayingGuest;
}

describe("authenticated layout staying-guest day boundary (#2838)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(new Date(PINNED_INSTANT));
    expectClubTimeZonePremise();

    mocks.auth.mockResolvedValue({
      user: { id: "member-1", name: "Mere Member", email: "m@example.test" },
    });
    mocks.headers.mockResolvedValue(new Headers());
    mocks.memberFindUnique.mockResolvedValue({
      id: "member-1",
      active: true,
      forcePasswordChange: false,
      role: "USER",
      accessRoles: ["USER"],
    });
    mocks.hasActiveHutLeaderAssignment.mockResolvedValue(false);
    withStay(null);
  });

  it("asks the @db.Date columns about today and tomorrow as date-only days", async () => {
    await isStayingGuest();

    const where = (
      mocks.bookingFindFirst.mock.calls[0]?.[0] as {
        where: { checkIn: DateFilter; checkOut: DateFilter };
      }
    ).where;
    expect(where.checkOut.gte?.toISOString()).toBe("2026-07-02T00:00:00.000Z");
    expect(where.checkIn.lte?.toISOString()).toBe("2026-07-03T00:00:00.000Z");
    expect(boundDay(where.checkOut.gte as Date)).toBe(CLUB_TODAY);
  });

  it("admits the member the DAY BEFORE check-in, as the rule says", async () => {
    withStay({ checkIn: "2026-07-03", checkOut: "2026-07-05" });

    expect(await isStayingGuest()).toBe(true);
  });

  it("still admits the member on the CHECK-OUT day itself", async () => {
    withStay({ checkIn: "2026-06-30", checkOut: CLUB_TODAY });

    expect(await isStayingGuest()).toBe(true);
  });

  it("does NOT admit the member the day after check-out", async () => {
    withStay({ checkIn: "2026-06-29", checkOut: "2026-07-01" });

    expect(await isStayingGuest()).toBe(false);
  });

  it("does NOT admit the member two days before check-in", async () => {
    withStay({ checkIn: "2026-07-04", checkOut: "2026-07-06" });

    expect(await isStayingGuest()).toBe(false);
  });
});
