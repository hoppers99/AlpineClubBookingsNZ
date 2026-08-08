// @vitest-environment jsdom

// #2664, create-side sibling. The requested-room EDITOR was fixed by pointing it
// at a booking-scoped read; the booking WIZARD is the other surface that offers a
// "Preferred room (optional)" choice, and it kept the shape the issue described.
//
// `/api/bookings/rooms` has two modes. With `lodgeId` it scopes to that lodge;
// with no `lodgeId` it lists active rooms across EVERY lodge the caller may book
// (`src/app/api/bookings/rooms/route.ts:41-61`). The wizard used to ask the
// second question whenever `lodgeId` was still null — which is every mount,
// because `lodgeId` starts null and only becomes concrete once `LodgeSelect`
// normalises the fetched lodge list.
//
// That alone would be a transient blip. What made it a defect is that the effect
// had no cancellation guard, so the LAST response to land won. A cross-lodge
// reply arriving after the lodge-scoped reply that superseded it left other
// lodges' rooms in `roomOptions` permanently — nothing refetches until the member
// switches lodge again — and `review-step.tsx:653-680` then renders them in the
// picker. Choosing one produced a create that `booking-create.ts:167` refuses
// with "Requested room belongs to a different lodge", i.e. a control that simply
// does not work, which is exactly the member-facing symptom in #2664.
//
// These tests reproduce that ordering rather than restating the fixture: the
// stub answers BOTH modes, with lodge B's Cedar reachable only through the
// unscoped one, and the unscoped reply is deliberately resolved last.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: { user: { id: "member-1", role: "MEMBER", accessRoles: [] } },
  }),
}));

vi.mock("@/lib/access-roles", () => ({
  hasAdminAccess: () => false,
  hasAccessRole: () => true,
}));

vi.mock("@/components/club-identity-provider", () => ({
  useClubIdentity: () => ({ lodgeCapacity: 20 }),
}));

// A two-lodge club, which is the only shape in which "the wrong lodge's rooms"
// is even expressible. The hook holds the selection itself; `LodgeSelect` is not
// rendered by `renderHook`, so these tests drive `handleLodgeChange` directly,
// which is precisely what that component's normalising effect calls.
vi.mock("@/components/lodge-select", () => ({
  useLodgeOptions: () => ({
    lodges: [
      { id: "lodge-a", name: "Alpine Lodge" },
      { id: "lodge-b", name: "Cedar Lodge" },
    ],
    loading: false,
  }),
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn() },
}));

import { useBookingWizard } from "@/app/(authenticated)/book/_hooks/use-booking-wizard";

function jsonResponse(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as Response;
}

// Lodge A's own rooms — what the scoped mode answers for `?lodgeId=lodge-a`.
const LODGE_A_ROOMS = {
  enabled: true,
  rooms: [{ id: "room-alpine", name: "Alpine", bedCount: 4 }],
};

// What the UNSCOPED mode answers a member eligible for both lodges. Cedar
// belongs to lodge B and is reachable from nowhere else in this file, so any
// assertion that finds it proves the wizard asked the cross-lodge question and
// kept the answer.
const EVERY_LODGE_ROOMS = {
  enabled: true,
  rooms: [
    { id: "room-alpine", name: "Alpine", bedCount: 4 },
    { id: "room-cedar", name: "Cedar", bedCount: 2 },
  ],
};

type RoomStubOptions = {
  // Held open so the test controls which reply lands last. The unscoped reply is
  // the one the old code let win.
  deferUnscoped?: boolean;
};

function stubFetch(options: RoomStubOptions = {}) {
  const releaseUnscoped: Array<() => void> = [];
  const fetchMock = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes("/api/members/family")) {
      return jsonResponse({ familyMembers: [] });
    }
    if (u.includes("/api/payments/options")) {
      return jsonResponse({
        methods: {
          stripe: { enabled: true, default: true },
          internetBanking: { enabled: false },
        },
        groupBookingsEnabled: false,
      });
    }
    if (u.includes("/api/member/subscription-status")) {
      return jsonResponse({
        status: "PAID",
        seasonDisplay: "2026",
        invoiceUrl: null,
        invoiceNumber: null,
      });
    }
    if (u.includes("/api/booking-messages")) {
      return jsonResponse({ messages: {} });
    }
    if (u.startsWith("/api/bookings/rooms")) {
      const scoped = u.includes("lodgeId=");
      if (scoped) {
        return jsonResponse(
          u.includes("lodgeId=lodge-a") ? LODGE_A_ROOMS : { enabled: true, rooms: [] },
        );
      }
      if (options.deferUnscoped) {
        return new Promise<Response>((resolve) => {
          releaseUnscoped.push(() => resolve(jsonResponse(EVERY_LODGE_ROOMS)));
        });
      }
      return jsonResponse(EVERY_LODGE_ROOMS);
    }
    return jsonResponse({}, false);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, releaseUnscoped };
}

/**
 * Every room request the wizard made that carried no lodge scope. Matched by
 * "starts with the path and has no `lodgeId=`" rather than by exact string, so a
 * regression that reintroduced the cross-lodge call with some other query
 * parameter on it is still caught.
 */
function unscopedRoomCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map((call) => String(call[0]))
    .filter((url) => url.startsWith("/api/bookings/rooms") && !url.includes("lodgeId="));
}

function roomIds(options: Array<{ id: string }>): string[] {
  return options.map((room) => room.id);
}

describe("booking wizard room options are scoped to the lodge being booked (#2664)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("never asks the cross-lodge room list, even before a lodge is selected", async () => {
    const { fetchMock } = stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    // The mount window is the whole point: `lodgeId` is null here, and the old
    // code fired the unscoped request immediately.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/api/member/subscription-status"))).toBe(true),
    );
    expect(result.current.lodgeId).toBeNull();
    expect(unscopedRoomCalls(fetchMock)).toEqual([]);
    expect(result.current.roomOptions).toEqual([]);
    expect(result.current.roomRequestEnabled).toBe(false);

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });

    await waitFor(() => expect(result.current.roomOptions).toHaveLength(1));
    expect(roomIds(result.current.roomOptions)).toEqual(["room-alpine"]);
    expect(result.current.roomRequestEnabled).toBe(true);
    // Still none, now that a real selection has driven a real request.
    expect(unscopedRoomCalls(fetchMock)).toEqual([]);
    expect(
      fetchMock.mock.calls.filter(([u]) =>
        String(u).startsWith("/api/bookings/rooms?lodgeId=lodge-a"),
      ),
    ).toHaveLength(1);
  });

  it("a superseded reply cannot put another lodge's room back in the picker", async () => {
    const { fetchMock, releaseUnscoped } = stubFetch({ deferUnscoped: true });
    const { result } = renderHook(() => useBookingWizard());

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });
    await waitFor(() => expect(result.current.roomOptions).toHaveLength(1));

    // Release every unscoped reply the hook could still be holding, and let the
    // promise chain and its state update flush. On the fixed hook there is
    // nothing to release; on the pre-fix hook this is the exact moment Cedar
    // overwrote lodge A's list and stayed there.
    await act(async () => {
      releaseUnscoped.forEach((release) => release());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The member-facing symptom first: a lodge B room offered on a lodge A
    // booking, which `booking-create.ts` would then refuse.
    expect(roomIds(result.current.roomOptions)).not.toContain("room-cedar");
    expect(roomIds(result.current.roomOptions)).toEqual(["room-alpine"]);
    // Then the cause: no cross-lodge request was ever outstanding to win.
    expect(releaseUnscoped).toHaveLength(0);
    expect(unscopedRoomCalls(fetchMock)).toEqual([]);
  });

  it("switching lodge asks for the new lodge and never widens the question", async () => {
    const { fetchMock } = stubFetch();
    const { result } = renderHook(() => useBookingWizard());

    await act(async () => {
      result.current.handleLodgeChange("lodge-a");
    });
    await waitFor(() => expect(result.current.roomOptions).toHaveLength(1));

    await act(async () => {
      result.current.handleLodgeChange("lodge-b");
    });

    // Lodge B has no rooms in this fixture, so an empty picker is the correct
    // answer — and Cedar, which lives at lodge B but is only reachable through
    // the unscoped mode, must not appear via that route either.
    await waitFor(() => expect(result.current.roomOptions).toEqual([]));
    expect(
      fetchMock.mock.calls.filter(([u]) =>
        String(u).startsWith("/api/bookings/rooms?lodgeId=lodge-b"),
      ),
    ).toHaveLength(1);
    expect(unscopedRoomCalls(fetchMock)).toEqual([]);
  });
});
