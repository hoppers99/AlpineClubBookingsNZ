// @vitest-environment jsdom

/**
 * #2425 — "keep typing", but only when the picker really did run out of room.
 *
 * The parent search asks for eight rows. Since #2282 lifted the adults-only
 * filter, a shared surname can produce more than eight eligible people, and the
 * list simply STOPPED — no adult, no explanation, and no way for the admin to
 * know that typing one more letter was the answer. The owner's second decision
 * (1 Aug 2026) is a truncation hint in the #2308 member-guest finder's own
 * words.
 *
 * Three things are pinned here, and each is a separate way to get it wrong:
 *
 *  1. THE SENTENCE IS THE MEMBER-GUEST FINDER'S, character for character. The
 *     admin picker keeps its own copy of the string rather than importing the
 *     member-facing one (that sentence carries privacy rules this surface does
 *     not share), so the only thing stopping the two drifting is this test.
 *  2. IT APPEARS ONLY WHEN THE PAGE WAS CUT SHORT. A hint under a complete list
 *     is worse than none: it tells the admin to keep typing for somebody who is
 *     not there.
 *  3. THE FLAG COMES FROM THE SERVER'S OWN TOTAL. `total > rows shown` is
 *     computed in the hook against the RAW page, so selecting a candidate —
 *     which removes that row from the rendered list — cannot fake a truncation.
 *
 * Mutation probes (each re-run and confirmed to turn this file red): drop the
 * `resultsTruncated &&` guard so the hint always renders; make the hook compare
 * against the post-filter list; make the hook read `members.length` instead of
 * `total`; change either copy of the sentence.
 */
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MemberParentLinkDialog } from "../member-parent-link-dialog";
import { useMemberParentLink } from "../../_hooks/use-member-parent-link";
import { MEMBER_SEARCH_TRUNCATED_HINT } from "@/lib/admin-member-detail-helpers";
import { MEMBER_GUEST_FIND_COPY } from "@/lib/member-guest-find";
import type { MemberDetail } from "../../_types";

const HINT = "Keep typing to narrow this down.";

function buildCandidate(index: number, ageTier = "CHILD") {
  return {
    id: `kingi-${index}`,
    firstName: `Kid${index}`,
    lastName: "Kingi",
    email: `kid${index}@kingi.example.org`,
    ageTier,
    active: true,
    canLogin: false,
    dateOfBirth: null,
    familyGroups: [],
  };
}

function buildMember(): MemberDetail {
  return {
    id: "member-1",
    firstName: "Tui",
    lastName: "Kingi",
    email: "tui@kingi.example.org",
    ageTier: "CHILD",
    role: "USER",
    accessRoles: ["USER"],
    active: true,
    archivedAt: null,
    canLogin: true,
    dependents: [],
    parentLinks: [],
    familyGroups: [],
    inheritEmailFromId: null,
    inheritEmailFrom: null,
  } as unknown as MemberDetail;
}

function renderDialog(overrides: Record<string, unknown> = {}) {
  // The dialog resolves the notification mailbox over the network when a
  // candidate is selected; nothing here selects one, so an inert fetch is
  // enough.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ source: null }) })) as never,
  );
  render(
    <MemberParentLinkDialog
      open
      onOpenChange={vi.fn()}
      member={buildMember()}
      search="kingi"
      searching={false}
      searchResults={[1, 2, 3, 4, 5, 6, 7, 8].map((index) => buildCandidate(index)) as never}
      selected={null}
      notificationParentId=""
      disableLogin={false}
      familyGroupIds={[]}
      saving={false}
      error=""
      onChangeSearch={vi.fn()}
      onSelectCandidate={vi.fn()}
      onClearSelection={vi.fn()}
      onChangeNotificationParentId={vi.fn()}
      onChangeDisableLogin={vi.fn()}
      onToggleFamilyGroup={vi.fn()}
      onSubmit={vi.fn()}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("#2425 — the parent picker's truncation hint", () => {
  it("says exactly what the member-guest finder says", () => {
    expect(MEMBER_SEARCH_TRUNCATED_HINT).toBe(HINT);
    expect(MEMBER_GUEST_FIND_COPY.truncated).toBe(HINT);
    expect(MEMBER_SEARCH_TRUNCATED_HINT).toBe(MEMBER_GUEST_FIND_COPY.truncated);
  });

  it("shows the hint under a page that was cut short", () => {
    renderDialog({ resultsTruncated: true });
    expect(screen.getByText(HINT)).toBeInTheDocument();
  });

  it("stays silent when the list holds everyone who matched", () => {
    renderDialog({ resultsTruncated: false });
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
  });

  it("stays silent when nobody matched at all", () => {
    // Defence in depth: the hint lives inside the results branch, so an empty
    // search can never reach it — but "keep typing" beneath "no eligible active
    // members found" would be actively misleading if it ever did.
    renderDialog({ searchResults: [], resultsTruncated: true });
    expect(screen.queryByText(HINT)).not.toBeInTheDocument();
    expect(
      screen.getByText("No eligible active members found."),
    ).toBeInTheDocument();
  });

  it("also says adults come first, so the order does not read as a bug", () => {
    renderDialog();
    // Both halves of the sentence: the ranking guarantees that MINORS come last
    // (an age-exempt member ranks with the adults, not among the children —
    // #2425 review), so the copy says that rather than only "adults first".
    expect(
      screen.getByText(
        /active member of any age; adults are listed ahead of any children or youth that match/i,
      ),
    ).toBeInTheDocument();
  });
});

describe("#2425 — where the truncated flag comes from", () => {
  async function runSearch(response: { members: unknown[]; total: number }) {
    vi.useFakeTimers();
    const requestedUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return { ok: true, json: async () => response };
    });
    vi.stubGlobal("fetch", fetchMock as never);

    const { result } = renderHook(() =>
      useMemberParentLink({
        member: buildMember(),
        fetchMember: vi.fn(),
        setLoading: vi.fn(),
        setRelationshipError: vi.fn(),
      }),
    );

    act(() => {
      result.current.openParentLinkDialog();
    });
    act(() => {
      result.current.setParentLinkSearch("kingi");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });

    expect(requestedUrls).not.toHaveLength(0);
    // The picker's own call path, and the page size the whole issue is about.
    expect(requestedUrls[0]).toContain("parentLinkEligibleFor=member-1");
    expect(requestedUrls[0]).toContain("pageSize=8");
    return result;
  }

  it("is true when the server counted more than it returned", async () => {
    const result = await runSearch({
      members: [1, 2, 3, 4, 5, 6, 7, 8].map((index) => buildCandidate(index)),
      total: 11,
    });
    expect(result.current.parentLinkSearchResults).toHaveLength(8);
    expect(result.current.parentLinkResultsTruncated).toBe(true);
  });

  it("is false when the page holds the whole eligible set", async () => {
    const result = await runSearch({
      members: [1, 2, 3].map((index) => buildCandidate(index)),
      total: 3,
    });
    expect(result.current.parentLinkResultsTruncated).toBe(false);
  });

  it("is not faked by a selection that drops a row from the rendered list", async () => {
    // A selected candidate is filtered out of the rendered list. Compared
    // against THAT list, a complete page of eight would read as eight of nine
    // and the dialog would tell the admin to keep typing for nobody. Set
    // directly rather than through `selectLinkParent`, which also clears the
    // search — that would end the search entirely and prove nothing.
    const result = await runSearch({
      members: [1, 2, 3, 4, 5, 6, 7, 8].map((index) => buildCandidate(index)),
      total: 8,
    });
    act(() => {
      result.current.setSelectedLinkParent(buildCandidate(1) as never);
    });
    expect(result.current.parentLinkSearchResults).toHaveLength(7);
    expect(result.current.parentLinkResultsTruncated).toBe(false);
  });
});
