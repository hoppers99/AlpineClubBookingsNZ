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

function stubFetch(lodges: Array<typeof OPEN_LODGE | typeof CLOSED_LODGE>) {
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
          json: async () => ({ lodges }),
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
    const urls = stubFetch([OPEN_LODGE, CLOSED_LODGE]);

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
    stubFetch([OPEN_LODGE, CLOSED_LODGE]);

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
    const urls = stubFetch([OPEN_LODGE, CLOSED_LODGE]);

    render(<ChoresPage />);

    await waitFor(() => expect(choreScope(urls)).toBe("lodge-1"));
    expect(
      urls.filter((url) => url.includes("lodgeId=lodge-2")),
    ).toEqual([]);
  });
});

/*
  #221 review, finding 1 (MED-LOW) — the club shape one lodge narrower than
  the suite above: the ONLY lodge is closed, rather than one open plus one
  being set up. `lodge-option-scope.test.ts` pins the mechanism directly;
  these pin it on the real page, because until this fix the two states —
  "still loading" and "the only lodge is closed" — were the same value and the
  page could not tell an operator apart from a network request that had not
  come back yet.
*/
describe("a configuration editor whose only lodge is closed (#221 review, finding 1)", () => {
  beforeEach(() => {
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

  it("settles to a terminal, honest notice rather than loading forever, with no ?lodgeId=", async () => {
    visit("");
    stubFetch([CLOSED_LODGE]);

    render(<ChoresPage />);

    await waitFor(() =>
      expect(screen.getByText("No lodge is open")).toBeInTheDocument(),
    );
    expect(
      screen.getByText(
        /chore templates cannot be shown or changed until a lodge is open for booking/i,
      ),
    ).toBeInTheDocument();
    // Never the stuck state this replaces.
    expect(
      screen.queryByText("Loading lodge options..."),
    ).not.toBeInTheDocument();
    // ADR-002 suppression still applies below two lodges: no selector either.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("keeps the named-closed-lodge scope line unchanged when ?lodgeId= names it", async () => {
    visit("?lodgeId=lodge-2");
    const urls = stubFetch([CLOSED_LODGE]);

    render(<ChoresPage />);

    await waitFor(() => expect(choreScope(urls)).toBe("lodge-2"));
    expect(screen.getByTestId("lodge-scope-line").textContent).toBe(
      `Lodge: New Lodge ${CLOSED_SUFFIX}`,
    );
    // The new terminal notice is for the UNNAMED case only; a deliberately
    // named closed lodge is a settled `"lodge"` scope, not `"closed"`.
    expect(screen.queryByText("No lodge is open")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Loading lodge options..."),
    ).not.toBeInTheDocument();
  });
});
