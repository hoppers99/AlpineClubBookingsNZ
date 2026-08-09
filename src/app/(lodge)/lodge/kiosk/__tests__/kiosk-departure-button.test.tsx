// @vitest-environment jsdom

/**
 * #2631 / #2628 — the Departing BADGE and the Mark Departed BUTTON are two
 * separate flags, and the button's must be exactly what the server will accept.
 *
 * `isDeparting` is the operational day: "somebody leaves the lodge today". A
 * sparse stay (nights {11, 14}) leaves the lodge twice — on the 12th and again
 * on the 15th — so the badge is correct on both mornings. The button rides on
 * `canMarkDeparted`, which the guests route derives from the depart endpoint's
 * OWN predicate (`isGuestDepartureMorning`), so the kiosk never offers a
 * check-out the server refuses and never withholds one it would accept.
 *
 * #2631 shipped this split with the flag computed as `stayEnd` equality, which
 * matched the endpoint AT THE TIME: it resolved its guest that way and 404'd on
 * any earlier morning. That made the sparse stay's first check-out
 * unrecordable — badge on, button withheld, nothing the hut leader could do.
 * #2628 fixed the endpoint per segment, so the button is now offered on BOTH
 * mornings. The two cases below are the same two cases, with the intermediate
 * one flipped to the answer the server now gives.
 *
 * Frozen clock discipline: the fixtures are anchored to a fixed instant in
 * July 2026 rather than to the real calendar.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import KioskPage from "../page";
import { frozenTestNow } from "@/lib/__tests__/helpers/clock";
import { captureHostTimeZone } from "@/lib/__tests__/helpers/timezone";
import { buildWeekDateKeys } from "../_components/kiosk-week-view";

// The club's zone, pinned independently of the host's (docs/TESTING.md).
vi.mock("@/config/operational", () => ({
  APP_TIME_ZONE: "Pacific/Auckland",
  APP_LOCALE: "en-NZ",
  APP_CURRENCY: "NZD",
  APP_STRIPE_CURRENCY: "nzd",
}));

vi.mock("@/components/kiosk-lodge-instructions", () => ({
  KioskLodgeInstructions: () => null,
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

// The sparse stay from the route fixture: nights {2026-07-11, 2026-07-14},
// `stayEnd` 2026-07-15. Present on the 11th, 12th, 14th and 15th, and leaving
// the lodge on the 12th AND the 15th. The two mornings fall in different
// kiosk weeks, so each case opens the kiosk on its own day.
const INTERMEDIATE_DEPARTURE = {
  dateKey: "2026-07-12",
  openLabel: "Open Sunday, 12 July",
};
const FINAL_DEPARTURE = {
  dateKey: "2026-07-15",
  openLabel: "Open Wednesday, 15 July",
};

/** The guest's return night, in the same stay: back on the 14th. */
const RETURN_NIGHT = {
  dateKey: "2026-07-14",
  openLabel: "Open Tuesday, 14 July",
};

function guestPayload(opts: {
  isDeparting: boolean;
  canMarkDeparted: boolean;
  isArriving?: boolean;
  canMarkArrived?: boolean;
  arrivedAt?: string | null;
  departedAt?: string | null;
}) {
  return {
    bookings: [
      {
        bookingId: "booking-1",
        memberName: "Bev Booker",
        expectedArrivalTime: null,
        blockedFromCheckin: false,
        guests: [
          {
            id: "sparse",
            firstName: "Sam",
            lastName: "Sparse",
            ageTier: "ADULT",
            isMember: false,
            isArriving: false,
            canMarkArrived: false,
            arrivedAt: null,
            departedAt: null,
            phone: null,
            ...opts,
          },
        ],
      },
    ],
    totalGuests: 1,
  };
}

/**
 * Serves the kiosk's endpoints with a week that spans both departure mornings,
 * and the given guest payload for whichever day is opened.
 */
function installFetchMock(payload: ReturnType<typeof guestPayload>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname;

    if (path === "/api/lodge/access") {
      return Response.json({
        tier: "hut-leader",
        dateRange: null,
        canManageRoster: true,
        canMarkAttendance: true,
        canCompleteChores: true,
        lodgeName: "Whakapapa",
      });
    }

    if (path === "/api/lodge/week") {
      const start = url.searchParams.get("start") ?? "";
      return Response.json({
        start,
        days: buildWeekDateKeys(start).map((date) => ({
          date,
          accessible: true,
          guestCount: 1,
          arrivingCount: 0,
          departingCount: 1,
          rosterStatus: "needs-roster",
        })),
      });
    }

    if (/^\/api\/lodge\/guests\/\d{4}-\d{2}-\d{2}$/.test(path)) {
      return Response.json(payload);
    }

    if (/^\/api\/lodge\/roster\/\d{4}-\d{2}-\d{2}$/.test(path)) {
      return Response.json({ assignments: [] });
    }

    throw new Error(`Unexpected fetch ${url}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** Opens the kiosk's day view on the given morning and returns the guest row. */
async function openGuestRow(day: {
  dateKey: string;
  openLabel: string;
}): Promise<HTMLElement> {
  // 02:00 UTC is mid-afternoon in New Zealand on the same date, so the club's
  // "today" — which is what the kiosk opens on — is the day under test.
  vi.setSystemTime(new Date(`${day.dateKey}T02:00:00.000Z`));

  render(<KioskPage />);

  fireEvent.click(await screen.findByRole("button", { name: day.openLabel }));

  const name = await screen.findByText("Sam Sparse");
  await waitFor(() => expect(screen.getByText("Lodge List")).toBeVisible());
  // The guest row is the flex container holding the name and the badges.
  const row = name.closest("div.flex.items-center.justify-between");
  if (!row) throw new Error("no guest row rendered for Sam Sparse");
  return row as HTMLElement;
}

const hostTimeZone = captureHostTimeZone();

describe("kiosk Mark Departed follows the check-out flag, not the badge (#2631)", () => {
  beforeEach(() => {
    process.env.TZ = "Pacific/Auckland";
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.setSystemTime(frozenTestNow());
    hostTimeZone.restore();
  });

  it("an intermediate departure morning shows the chip AND the button (#2628)", async () => {
    installFetchMock(
      guestPayload({ isDeparting: true, canMarkDeparted: true }),
    );

    const row = await openGuestRow(INTERMEDIATE_DEPARTURE);

    // The badge is right: they really are leaving the lodge this morning.
    expect(within(row).getByText("Departing")).toBeVisible();
    // …and so is the button now, because the endpoint accepts this morning.
    expect(
      within(row).getByRole("button", { name: "Mark Departed" }),
    ).toBeVisible();
  });

  it("the FINAL departure morning shows the chip and the button together", async () => {
    installFetchMock(
      guestPayload({ isDeparting: true, canMarkDeparted: true }),
    );

    const row = await openGuestRow(FINAL_DEPARTURE);

    expect(within(row).getByText("Departing")).toBeVisible();
    expect(
      within(row).getByRole("button", { name: "Mark Departed" }),
    ).toBeVisible();
  });

  it("leaves a control on the row when the guest comes BACK (#2628)", async () => {
    // The dead end an intermediate check-out used to create. `departedAt` is
    // one column for the whole stay, so on the return night it still holds the
    // 12th's departure: the row was faded, the check-in button was hidden on
    // `!departedAt`, and the check-out button was correctly absent because the
    // 14th is a night, not a departure morning. The hut leader was left with
    // NOTHING to press for a guest standing in front of them.
    installFetchMock(
      guestPayload({
        isDeparting: false,
        canMarkDeparted: false,
        isArriving: true,
        canMarkArrived: true,
        arrivedAt: "2026-07-11T06:00:00.000Z",
        departedAt: "2026-07-12T22:00:00.000Z",
      }),
    );

    const row = await openGuestRow(RETURN_NIGHT);

    expect(within(row).getByText("Arriving")).toBeVisible();
    // Offered, and offered as an ACTION — a stale `arrivedAt` from the first
    // segment must not render as "Arrived" for a guest who has not checked back
    // in yet.
    expect(within(row).getByRole("button", { name: "Mark Arrived" })).toBeVisible();
    expect(within(row).queryByRole("button", { name: "Arrived" })).toBeNull();
    // And the row is not greyed out as departed while they are standing there.
    expect(row.className).not.toContain("opacity-60");
  });

  it("STILL WITHHOLDS the button where the server would refuse", async () => {
    // The split itself, which #2628 narrowed but did not remove. The two flags
    // coincide today; the button must follow the SERVER's flag, so a payload
    // where they disagree renders the badge and no button. Gate the button on
    // `isDeparting` instead and this fails.
    installFetchMock(
      guestPayload({ isDeparting: true, canMarkDeparted: false }),
    );

    const row = await openGuestRow(INTERMEDIATE_DEPARTURE);

    expect(within(row).getByText("Departing")).toBeVisible();
    expect(
      within(row).queryByRole("button", { name: "Mark Departed" }),
    ).toBeNull();
  });
});
