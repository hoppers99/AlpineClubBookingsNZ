// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #2142 review (round 3): the round-2 fix taught the DEFAULT CANCELLATION
// section that a snapshot is authoritative only for the scope it was loaded for,
// and `AGENTS.md` / `docs/ARCHITECTURE.md` now state that as binding. The two
// LIST sections fetched on exactly the same key and did not honour it: their
// `catch` set `error` and left the rows alone, so after a failed switch to a
// lodge the card was retitled "… — Lodge One", said "Periods listed here belong
// to Lodge One", and left Edit, Delete (a HARD delete, for periods) and
// Activate/Deactivate live over rows that were still the CLUB-WIDE set. Every
// one of those buttons acts on a row id, so they hit club-wide rows the admin
// believed they had navigated away from — strictly worse than the cancellation
// defect the same change had just fixed.
//
// These tests pin the same invariant in both list sections: a mismatch between
// the scope on screen and the scope the rows were loaded for is UNKNOWN — no
// rows, no editor, no destructive affordances — until a load for the current
// scope succeeds.

const LODGES = vi.hoisted(() => [
  { id: "lodge-1", name: "Lodge One" },
  { id: "lodge-2", name: "Lodge Two" },
]);

vi.mock("@/hooks/use-admin-area-edit-access", () => ({
  useAdminAreaEditAccess: () => true,
  ADMIN_VIEW_ONLY_ACTION_REASON: "View-only reason",
}));

vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({ lodges: LODGES, loading: false }),
}));

// The real scope control is a portalled, pointer-driven Radix `Select`, which is
// not the subject here — the section's reaction to a scope CHANGE is. A plain
// native select drives the same `onChange` contract.
vi.mock("../policy-scope-select", () => ({
  PolicyScopeSelect: ({
    value,
    onChange,
  }: {
    value: string | null;
    onChange: (lodgeId: string | null) => void;
    id?: string;
  }) => (
    <select
      aria-label="Rules for"
      value={value ?? ""}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">Club-wide rules (default)</option>
      {LODGES.map((lodge) => (
        <option key={lodge.id} value={lodge.id}>
          {lodge.name}
        </option>
      ))}
    </select>
  ),
  usePolicyScopeLodgeName: (lodgeId: string | null) =>
    LODGES.find((lodge) => lodge.id === lodgeId)?.name ?? null,
}));

import { BookingPeriodsSection } from "../booking-periods-section";
import { MinimumNightStaySection } from "../minimum-night-stay-section";

const CLUB_PERIOD = {
  id: "club-period",
  name: "Club Wide Holidays",
  startDate: "2026-07-01T00:00:00.000Z",
  endDate: "2026-07-14T00:00:00.000Z",
  nonMemberHoldEnabled: true,
  nonMemberHoldDays: 5,
  cancellationRules: [],
  active: true,
};

const CLUB_MIN_STAY = {
  id: "club-min-stay",
  name: "Club Wide Saturdays",
  startDate: "2026-07-01T00:00:00.000Z",
  endDate: "2026-09-30T00:00:00.000Z",
  triggerDays: [6],
  minimumNights: 2,
  active: true,
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Route each GET by scope; the lodge partition either fails or returns rows. */
function stubFetch(clubRows: unknown[], lodgeOne: "fail" | unknown[]) {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
    async (url) => {
      if (url.includes("lodgeId=lodge-1")) {
        return lodgeOne === "fail"
          ? new Response("{}", { status: 500 })
          : jsonResponse(lodgeOne);
      }
      return jsonResponse(clubRows);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function switchScopeTo(value: string) {
  fireEvent.change(screen.getByLabelText("Rules for") as HTMLSelectElement, {
    target: { value },
  });
}

function writeCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) => (call[1] as RequestInit | undefined)?.method !== undefined,
  );
}

beforeEach(() => {
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BookingPeriodsSection scope switching (#2142 review)", () => {
  it("shows the lodge's own periods after a SUCCESSFUL switch", async () => {
    stubFetch(
      [CLUB_PERIOD],
      [{ ...CLUB_PERIOD, id: "lodge-period", name: "Lodge One Holidays" }],
    );
    render(<BookingPeriodsSection />);
    await waitFor(() =>
      expect(screen.getByText("Club Wide Holidays")).toBeTruthy(),
    );

    switchScopeTo("lodge-1");

    await waitFor(() =>
      expect(screen.getByText("Lodge One Holidays")).toBeTruthy(),
    );
    expect(screen.queryByText("Club Wide Holidays")).toBeNull();
  });

  it("shows no rows and no row actions when the switch FAILS, so club-wide periods cannot be edited or deleted under a lodge's name", async () => {
    const fetchMock = stubFetch([CLUB_PERIOD], "fail");
    render(<BookingPeriodsSection />);
    await waitFor(() =>
      expect(screen.getByText("Club Wide Holidays")).toBeTruthy(),
    );

    switchScopeTo("lodge-1");

    await waitFor(() =>
      expect(
        screen.getByText(/Could not load the booking periods for Lodge One/i),
      ).toBeTruthy(),
    );
    // The club-wide row is gone, and so is every button that acted on it.
    expect(screen.queryByText("Club Wide Holidays")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
    // Nor is the section offering to ADD to a partition it cannot read.
    expect(screen.queryByRole("button", { name: "Add Period" })).toBeNull();
    // Not relabelled as the lodge's, either.
    expect(
      screen.queryByText(/Date-Specific Periods — Lodge One/),
    ).toBeNull();
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  it("closes an open editor on a scope switch, so its row id cannot follow the admin to another partition", async () => {
    stubFetch([CLUB_PERIOD], []);
    render(<BookingPeriodsSection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Update Period" })).toBeTruthy();

    switchScopeTo("lodge-1");

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Update Period" }),
      ).toBeNull(),
    );
  });

  it("restores the list when the admin switches back to a scope that loads", async () => {
    stubFetch([CLUB_PERIOD], "fail");
    render(<BookingPeriodsSection />);
    await waitFor(() =>
      expect(screen.getByText("Club Wide Holidays")).toBeTruthy(),
    );

    switchScopeTo("lodge-1");
    await waitFor(() =>
      expect(
        screen.getByText(/Could not load the booking periods/i),
      ).toBeTruthy(),
    );

    switchScopeTo("");

    await waitFor(() =>
      expect(screen.getByText("Club Wide Holidays")).toBeTruthy(),
    );
    expect(
      screen.queryByText(/Could not load the booking periods/i),
    ).toBeNull();
  });
});

describe("MinimumNightStaySection scope switching (#2142 review)", () => {
  it("shows the lodge's own policies after a SUCCESSFUL switch", async () => {
    stubFetch(
      [CLUB_MIN_STAY],
      [{ ...CLUB_MIN_STAY, id: "lodge-min", name: "Lodge One Saturdays" }],
    );
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByText("Club Wide Saturdays")).toBeTruthy(),
    );

    switchScopeTo("lodge-1");

    await waitFor(() =>
      expect(screen.getByText("Lodge One Saturdays")).toBeTruthy(),
    );
    expect(screen.queryByText("Club Wide Saturdays")).toBeNull();
  });

  it("shows no rows and no row actions when the switch FAILS", async () => {
    const fetchMock = stubFetch([CLUB_MIN_STAY], "fail");
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByText("Club Wide Saturdays")).toBeTruthy(),
    );

    switchScopeTo("lodge-1");

    await waitFor(() =>
      expect(
        screen.getByText(
          /Could not load the minimum-stay policies for Lodge One/i,
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText("Club Wide Saturdays")).toBeNull();
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deactivate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Policy" })).toBeNull();
    expect(screen.queryByText(/Minimum Night Stay — Lodge One/)).toBeNull();
    expect(writeCalls(fetchMock)).toHaveLength(0);
  });

  it("closes an open editor on a scope switch", async () => {
    stubFetch([CLUB_MIN_STAY], []);
    render(<MinimumNightStaySection />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Update Policy" })).toBeTruthy();

    switchScopeTo("lodge-1");

    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Update Policy" }),
      ).toBeNull(),
    );
  });
});

// A failed FIRST load is the same hole at its widest: club-wide scope is `null`,
// so a "loaded scope" seeded with `null` would compare EQUAL to it and present
// an empty, never-loaded list as the club's real configuration — complete with
// "No date-specific periods configured. The default policy applies to all
// bookings.", which is a factual claim about the club nobody checked.
describe("a failed FIRST load is unknown, not empty (#2142 review)", () => {
  it("does not present a never-loaded booking-period list as an empty one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    render(<BookingPeriodsSection />);

    await waitFor(() =>
      expect(
        screen.getByText(/Could not load the booking periods for the club/i),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByText(/No date-specific periods configured/i),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Period" })).toBeNull();
  });

  it("does not present a never-loaded minimum-stay list as an empty one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    render(<MinimumNightStaySection />);

    await waitFor(() =>
      expect(
        screen.getByText(
          /Could not load the minimum-stay policies for the club/i,
        ),
      ).toBeTruthy(),
    );
    expect(
      screen.queryByText(/No minimum night stay policies configured/i),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Add Policy" })).toBeNull();
  });
});
