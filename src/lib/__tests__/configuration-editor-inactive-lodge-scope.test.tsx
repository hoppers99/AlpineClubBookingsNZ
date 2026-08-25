// @vitest-environment jsdom

/**
 * A configuration editor, pointed at a lodge that is not open yet (#221).
 *
 * `lodge-select.test.tsx` and `use-lodge-options.test.tsx` pin the two halves of
 * the mechanism separately. This pins them TOGETHER, on a real editor page,
 * because the defect they exist to prevent only appeared once they were joined
 * up and it appeared silently:
 *
 *   a club with one open lodge adds a second, which now starts INACTIVE; the
 *   setup flow tells the operator to finish the job in the full editors and
 *   links them with `?lodgeId=<the-new-lodge>`; the editor's option list
 *   dropped inactive lodges, so ADR-002 saw a single-lodge club, rendered no
 *   selector, and reported the OPEN lodge — and every chore, room, bed, locker,
 *   season and rate created from there was written against the wrong lodge,
 *   with nothing on screen to say so.
 *
 * Chores is the editor under test: it is the smallest of the five and the only
 * one whose GET is lodge-scoped in the URL, so "which lodge did this page
 * actually act on" is directly observable rather than inferred.
 *
 * Nothing here mocks `useLodgeOptions` or `LodgeSelect`. Mocking either would
 * remove the very seam the defect lived in.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLOSED_SUFFIX } from "@/components/lodge-select";

vi.mock("next-auth/react", () => ({
  useSession: () => ({
    data: {
      user: {
        id: "admin-1",
        adminPermissionMatrix: {
          overview: "view",
          bookings: "edit",
          membership: "edit",
          finance: "edit",
          lodge: "edit",
          content: "view",
          support: "view",
        },
      },
    },
    status: "authenticated",
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/admin/chores",
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/components/confirm-dialog", () => ({
  useConfirm: () => ({ confirm: vi.fn(async () => false), confirmDialog: null }),
}));

import ChoresPage from "@/app/(admin)/admin/chores/page";

const OPEN_LODGE = { id: "lodge-1", name: "Alpine Lodge", active: true };
const CLOSED_LODGE = { id: "lodge-2", name: "New Lodge", active: false };

function stubFetch() {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("/api/admin/lodges")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ lodges: [OPEN_LODGE, CLOSED_LODGE] }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    }),
  );
  return urls;
}

/** The chores GET is the page's statement of which lodge it is editing. */
function choreScope(urls: string[]): string | null {
  const read = urls.find((url) => url.startsWith("/api/admin/chores?"));
  return read ? new URLSearchParams(read.split("?")[1]).get("lodgeId") : null;
}

function visit(search: string) {
  window.history.replaceState({}, "", `/admin/chores${search}`);
}

describe("a configuration editor follows a ?lodgeId= to a closed lodge (#221)", () => {
  beforeEach(() => {
    // Radix Select measures and scrolls; jsdom implements neither.
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    visit("");
  });

  it("scopes its reads to the lodge the link named, not to the open one", async () => {
    visit("?lodgeId=lodge-2");
    const urls = stubFetch();

    render(<ChoresPage />);

    await waitFor(() => expect(choreScope(urls)).toBe("lodge-2"));
    // …and never asked about the open lodge on the way, which is what the
    // silent substitution looked like.
    expect(
      urls.filter((url) => url.includes("lodgeId=lodge-1")),
    ).toEqual([]);
  });

  it("says on screen which lodge that is, and that it is closed", async () => {
    visit("?lodgeId=lodge-2");
    stubFetch();

    render(<ChoresPage />);

    // Two configurable lodges is not a single-lodge club, so ADR-002's
    // suppression does not apply and the selector renders with the label.
    await waitFor(() =>
      expect(screen.getByRole("combobox")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(`New Lodge ${CLOSED_SUFFIX}`),
    ).toBeInTheDocument();
  });

  it("still defaults to the OPEN lodge when the operator named nothing", async () => {
    // Arriving from the nav rather than from a setup link. The widened list must
    // not change where an unnamed page lands.
    visit("");
    const urls = stubFetch();

    render(<ChoresPage />);

    await waitFor(() => expect(choreScope(urls)).toBe("lodge-1"));
    expect(
      urls.filter((url) => url.includes("lodgeId=lodge-2")),
    ).toEqual([]);
  });
});
