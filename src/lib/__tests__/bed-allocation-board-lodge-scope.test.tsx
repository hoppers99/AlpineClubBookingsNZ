// @vitest-environment jsdom

/*
 * #2701 — the bed-allocation board's lodge scope means exactly one thing.
 *
 * Before this, `null` stood for three unrelated situations at once — "I chose
 * to see every lodge", "the selector has not resolved yet" and
 * "/api/admin/lodges failed" — and the board's four bed pickers offered every
 * lodge's beds in all three, including the two nobody chose. A test that only
 * proved the happy path would have missed every one of them, so each situation
 * is pinned here separately:
 *
 *   - a DIRECT visit fetches nothing until it has settled on a real lodge, so
 *     the transient club-wide board is gone rather than merely tidied up;
 *   - a FAILED lodge list is an error with a retry, and cannot produce the same
 *     screen as a deliberate All lodges;
 *   - a DEEP LINK lands on the focused booking's own lodge, even when that is
 *     not the first lodge in the options list.
 *
 * The real `LodgeSelect` and `useLodgeOptions` are used deliberately — the
 * defect lived in their normalising effect, so a stubbed selector would prove
 * nothing about it.
 *
 * THE FAKE SERVER HERE REFUSES THROUGH THE REAL PREDICATE
 * (`boardLodgeScopeMismatch`, the same function `GET /api/admin/bed-allocation`
 * calls). That is what makes "the 409 cannot fire on normal navigation" a real
 * proof rather than a restatement: if the board ever sends a contradictory
 * `bookingId`/`lodgeId` pair, these tests see the refusal.
 */

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardPayload } from "@/app/(admin)/admin/bed-allocation/_components/types";
import {
  BOARD_LODGE_MISMATCH_CODE,
  BOARD_LODGE_MISMATCH_MESSAGE,
  boardLodgeScopeMismatch,
} from "@/lib/bed-allocation-board-scope";

const search = vi.hoisted(() => ({ current: "from=2026-07-01&to=2026-07-08" }));
const editAccessMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search.current),
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DragOverlay: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  KeyboardSensor: class {},
  PointerSensor: class {},
  closestCenter: vi.fn(),
  useSensor: vi.fn(),
  useSensors: () => [],
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/hooks/use-admin-area-edit-access", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/use-admin-area-edit-access")>();
  return { ...actual, useAdminAreaEditAccess: () => editAccessMock() };
});

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ hutLeaderLabel: "Hut Leader" }),
}));

vi.mock("@/components/admin/bed-allocation-removal-dialog", () => ({
  bedAllocationRemovalCategoryForAnchor: () => "MANUAL_DRAFT",
  useBedAllocationRemovalDialog: () => ({
    openRemovalDialog: vi.fn(),
    dialog: <div data-testid="removal-dialog-seam" />,
  }),
}));
vi.mock("@/components/admin/bed-allocation-move-dialog", () => ({
  useBedAllocationMoveDialog: () => ({
    openMoveDialog: vi.fn(),
    dialog: <div data-testid="move-dialog-seam" />,
  }),
}));
vi.mock("@/app/(admin)/admin/bed-allocation/_components/room-table", () => ({
  RoomTable: () => <div data-testid="room-table" />,
}));
vi.mock("@/app/(admin)/admin/bed-allocation/_components/bucket-board", () => ({
  BucketBoard: () => <div data-testid="bucket-board" />,
}));
vi.mock("@/components/admin/bed-range-assign-dialog", () => ({
  BedRangeAssignDialog: () => null,
}));
// Its own suite covers it; here it would only add a second endpoint to fake.
vi.mock(
  "@/app/(admin)/admin/bed-allocation/_components/allocation-preferences-section",
  () => ({
    AllocationPreferencesSection: () => (
      <div data-testid="allocation-preferences" />
    ),
  }),
);

import AdminBedAllocationPage from "@/app/(admin)/admin/bed-allocation/page";

const LODGES = [
  { id: "lodge-1", name: "Alpine Lodge", active: true },
  { id: "lodge-2", name: "River Lodge", active: true },
];

// booking-b lives at the SECOND lodge, so every "first lodge wins" defect shows
// up as a visible disagreement rather than an accidental pass.
const BOOKING_LODGE: Record<string, string> = { "booking-b": "lodge-2" };

function buildPayload(scopedLodgeId: string | null): DashboardPayload {
  return {
    settings: {
      autoAllocationEnabled: true,
      allocationPriorityOrder: [],
      updatedAt: null,
      updatedByMemberId: null,
    },
    range: { fromDate: "2026-07-01", toDate: "2026-07-08" },
    rooms: [
      {
        id: "room-1",
        name: "Example Room",
        sortOrder: 1,
        active: true,
        notes: null,
        beds: [
          {
            id: "bed-1",
            name: "Bed One",
            sortOrder: 1,
            active: true,
            bedType: "SINGLE",
            notes: null,
            bunkGroupId: null,
            bunkPosition: null,
          },
        ],
      },
    ],
    bookings: [],
    allocations: [],
    unallocatedGuestNights: [],
    exclusiveHolds: [],
    custodianHolds: [],
    suggestedAllocations: [],
    suggestedUnallocatedGuestNights: [],
    warnings: [],
    focusedBooking: null,
    scopedLodgeId,
  } as unknown as DashboardPayload;
}

interface FakeServer {
  /** Every board request the page made, in order. */
  boardRequests: URLSearchParams[];
  /** Board requests the server REFUSED with the 409 backstop. */
  refusals: URLSearchParams[];
  /** Resolve the pending `/api/admin/lodges` response. */
  releaseLodges: () => void;
  /** Resolve the pending FIRST `/api/admin/bed-allocation` response. */
  releaseFirstBoard: () => void;
  /** Make the next `/api/admin/lodges` attempt fail (or succeed again). */
  setLodgesFailing: (failing: boolean) => void;
}

function installFakeServer(options?: {
  holdLodges?: boolean;
  /**
   * Hold the FIRST board response open. Without this the two endpoints race,
   * and the order that matters — options land while the deep link's board read
   * is still in flight — is the one that happens to lose. It is also the
   * realistic order: `/api/admin/lodges` is the smaller query.
   */
  holdFirstBoard?: boolean;
  lodgesFailing?: boolean;
}): FakeServer {
  const state: FakeServer = {
    boardRequests: [],
    refusals: [],
    releaseLodges: () => {},
    releaseFirstBoard: () => {},
    setLodgesFailing: (failing) => {
      lodgesFailing = failing;
    },
  };
  let lodgesFailing = options?.lodgesFailing ?? false;
  let release = () => {};
  const gate = options?.holdLodges
    ? new Promise<void>((resolve) => {
        release = resolve;
      })
    : Promise.resolve();
  state.releaseLodges = () => release();

  let releaseBoard = () => {};
  let boardGate: Promise<void> | null = options?.holdFirstBoard
    ? new Promise<void>((resolve) => {
        releaseBoard = resolve;
      })
    : null;
  state.releaseFirstBoard = () => releaseBoard();

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);

      if (url.startsWith("/api/admin/lodges")) {
        await gate;
        if (lodgesFailing) {
          return {
            ok: false,
            status: 500,
            json: async () => ({ error: "boom" }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ lodges: LODGES }) };
      }

      if (url.startsWith("/api/admin/bed-allocation?")) {
        const params = new URLSearchParams(url.split("?")[1]);
        state.boardRequests.push(params);
        if (boardGate) {
          const pending = boardGate;
          boardGate = null;
          await pending;
        }
        const bookingId = params.get("bookingId");
        const requestedLodgeId = params.get("lodgeId");
        const bookingLodgeId = bookingId
          ? (BOOKING_LODGE[bookingId] ?? null)
          : null;
        // The REAL refusal rule, imported rather than restated.
        if (boardLodgeScopeMismatch(bookingLodgeId, requestedLodgeId)) {
          state.refusals.push(params);
          return {
            ok: false,
            status: 409,
            json: async () => ({
              error: BOARD_LODGE_MISMATCH_MESSAGE,
              code: BOARD_LODGE_MISMATCH_CODE,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => buildPayload(bookingLodgeId ?? requestedLodgeId),
        };
      }

      throw new Error(`unexpected fetch: ${url}`);
    }),
  );

  return state;
}

beforeEach(() => {
  editAccessMock.mockReturnValue(true);
  search.current = "from=2026-07-01&to=2026-07-08";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("bed-allocation board — a direct visit settles on a real lodge (#2701)", () => {
  it("asks for no board at all while the lodge options are still in flight", async () => {
    const server = installFakeServer({ holdLodges: true });

    render(<AdminBedAllocationPage />);

    // MUTATION PROBE: drop `scopeCanLoadBoard` from the dashboard hook's
    // `enabled` and this fails immediately — the board fires an unscoped
    // request on every mount, which is the transient club-wide read this issue
    // exists to remove. Nothing else in the repo notices.
    // Two matches by design: the Spinner's screen-reader label and the visible
    // text beside it say the same thing.
    await screen.findAllByText("Choosing which lodge to show");
    expect(server.boardRequests).toHaveLength(0);

    server.releaseLodges();

    await waitFor(() => expect(server.boardRequests).toHaveLength(1));
    // And the FIRST thing it ever asks for is a concrete lodge, never the
    // club-wide read.
    expect(server.boardRequests[0]?.get("lodgeId")).toBe("lodge-1");
    await screen.findByTestId("room-table");
  });

  it("honours a lodgeId already on the URL rather than defaulting past it", async () => {
    search.current = "from=2026-07-01&to=2026-07-08&lodgeId=lodge-2";
    const server = installFakeServer();

    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");

    expect(
      server.boardRequests.every(
        (request) => request.get("lodgeId") === "lodge-2",
      ),
    ).toBe(true);
    expect(screen.getByText("River Lodge")).toBeInTheDocument();
  });
});

describe("bed-allocation board — a failed lodge list is not a club-wide view (#2701)", () => {
  it("shows an error with a retry, loads no board, and never looks like All lodges", async () => {
    const server = installFakeServer({ lodgesFailing: true });

    render(<AdminBedAllocationPage />);

    await screen.findByText("The lodge list could not be loaded");

    // The distinction is BY CONSTRUCTION, not by the message: with no options
    // there is nothing to select, so the board asks for nothing rather than
    // reading the whole club.
    expect(server.boardRequests).toHaveLength(0);
    // And the deliberate club-wide screen is definitively absent, so the two
    // states cannot be confused with each other.
    expect(
      screen.queryByText("All lodges — read-only overview"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/This board is showing every lodge/),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("room-table")).not.toBeInTheDocument();
  });

  it("recovers through the retry affordance", async () => {
    const server = installFakeServer({ lodgesFailing: true });

    render(<AdminBedAllocationPage />);
    await screen.findByText("The lodge list could not be loaded");

    server.setLodgesFailing(false);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await screen.findByTestId("room-table");
    expect(server.boardRequests.at(-1)?.get("lodgeId")).toBe("lodge-1");
    expect(
      screen.queryByText("The lodge list could not be loaded"),
    ).not.toBeInTheDocument();
  });
});

describe("bed-allocation board — a deep-linked booking brings its own lodge (#2701)", () => {
  it("lands a second-lodge booking on the SECOND lodge's board when the link names no lodge", async () => {
    search.current = "from=2026-07-01&to=2026-07-08&bookingId=booking-b";
    // The order that matters: the lodge options arrive while the board read is
    // still in flight, so the selector is holding two lodges and no selection
    // at the exact moment it would otherwise default to the first one.
    const server = installFakeServer({ holdFirstBoard: true });

    render(<AdminBedAllocationPage />);
    // The selector renders as soon as two lodges are known (ADR-002).
    await screen.findByRole("combobox");

    // MUTATION PROBE for the deferral: drop `deferDefaultSelection` from the
    // board's `LodgeSelect` and this is where it breaks — the selector fires
    // `lodges[0]`, the board asks again pairing booking-b with lodge-1, and
    // the server refuses it. That is the defence firing on ordinary
    // navigation, which is the one thing it must never do.
    expect(server.boardRequests).toHaveLength(1);
    expect(server.boardRequests[0]?.has("lodgeId")).toBe(false);

    server.releaseFirstBoard();
    await screen.findByTestId("room-table");

    // The selector, the board and the focus all agree on lodge two — the
    // booking's own lodge — even though lodge one is first in the options list
    // and used to win by default.
    await waitFor(() =>
      expect(server.boardRequests.at(-1)?.get("lodgeId")).toBe("lodge-2"),
    );
    expect(screen.getByText("River Lodge")).toBeInTheDocument();
    expect(screen.getByText("Focused booking")).toBeInTheDocument();
    expect(server.boardRequests.at(-1)?.get("bookingId")).toBe("booking-b");
    expect(server.refusals).toEqual([]);
    // MUTATION PROBE for the adoption effect: delete it and the selection never
    // becomes lodge-2, so no request ever carries it.
    expect(
      server.boardRequests.some(
        (request) => request.get("lodgeId") === "lodge-1",
      ),
    ).toBe(false);
  });

  it("keeps the deep link the booking page actually builds on its own lodge", async () => {
    // `AdminBookingToolsCard` sends the booking AND `booking.lodgeId`. That
    // pair agrees, so it is served, and the selector reads the same lodge the
    // data came from.
    search.current =
      "from=2026-07-01&to=2026-07-08&bookingId=booking-b&lodgeId=lodge-2";
    const server = installFakeServer();

    render(<AdminBedAllocationPage />);
    await screen.findByTestId("room-table");

    expect(server.refusals).toHaveLength(0);
    expect(screen.getByText("River Lodge")).toBeInTheDocument();
    expect(screen.getByText("Focused booking")).toBeInTheDocument();
  });
});

describe("bed-allocation board — the LODGE_MISMATCH backstop (#2701)", () => {
  it("never fires on normal navigation: arrive on a deep link, then browse to another lodge", async () => {
    // This is the test the 409 exists for. The fake server refuses through the
    // same predicate the route uses, so any contradictory pair the board sends
    // — on the first load, on the adoption reload, or after the admin changes
    // lodge — is recorded here and fails the assertion.
    search.current = "from=2026-07-01&to=2026-07-08&bookingId=booking-b";
    const server = installFakeServer({ holdFirstBoard: true });

    render(<AdminBedAllocationPage />);
    await screen.findByRole("combobox");
    server.releaseFirstBoard();
    await screen.findByTestId("room-table");
    await waitFor(() =>
      expect(server.boardRequests.at(-1)?.get("lodgeId")).toBe("lodge-2"),
    );

    // The admin now picks the OTHER lodge from the selector — the one the
    // focused booking does not belong to. That drops the focus, so the pair
    // that would contradict is never sent in the first place.
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "Alpine Lodge" }));

    await waitFor(() => {
      const latest = server.boardRequests.at(-1);
      expect(latest?.get("lodgeId")).toBe("lodge-1");
      expect(latest?.has("bookingId")).toBe(false);
    });
    await waitFor(() =>
      expect(screen.queryByText("Focused booking")).not.toBeInTheDocument(),
    );

    expect(server.refusals).toEqual([]);
    expect(
      screen.queryByText("This link points at two different lodges"),
    ).not.toBeInTheDocument();
  });

  it("explains itself when a hand-made link names a booking at one lodge and a board at another", async () => {
    // Only reachable by typing the URL or by a bug, which is precisely why it
    // may be a hard refusal rather than a silent correction.
    search.current =
      "from=2026-07-01&to=2026-07-08&bookingId=booking-b&lodgeId=lodge-1";
    const server = installFakeServer();

    render(<AdminBedAllocationPage />);

    await screen.findByText("This link points at two different lodges");
    expect(server.refusals).toHaveLength(1);
    // No internally contradictory board is rendered underneath it, and no
    // "Try again" that could only refuse again.
    expect(screen.queryByTestId("room-table")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Bed allocation could not be loaded"),
    ).not.toBeInTheDocument();
  });
});
