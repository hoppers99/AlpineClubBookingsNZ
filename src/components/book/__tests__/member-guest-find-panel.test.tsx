// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemberGuestFindPanel } from "@/components/book/member-guest-find-panel";
import { MEMBER_GUEST_FIND_COPY } from "@/lib/member-guest-find";

/*
  The find panel's own tests (MG3 #2308).

  WHY THIS FILE EXISTS. The panel is the most interactive thing in the release —
  a debounced type-ahead, a pick-list, a chip, seven message states — and it
  shipped with NO component test at all. `guests-step.test.tsx` mocks
  `GuestForm` away and only threads props; the e2e spec asserts on responses, not
  on the panel. So every one of the nine defects the UX review found by hand was
  invisible to CI, including two that made the DEFAULT configuration unusable by
  keyboard. Each test below names the finding it pins.

  All of these are real assertions on rendered output and observed fetches, never
  probe counts.
*/

// Comfortably past the 300 ms debounce.
const SEARCH_SETTLE_MS = 400;

const SAM = {
  memberId: "m-sam",
  firstName: "Sam",
  lastName: "Whittaker",
  ageTier: "ADULT" as const,
};
const ELLA = {
  memberId: "m-ella",
  firstName: "Ella",
  lastName: "Whittaker",
  ageTier: "CHILD" as const,
};

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function stubFetch(
  handler: (url: string) => Response | Promise<Response> = () =>
    jsonResponse({ candidates: [] }),
) {
  fetchMock = vi.fn(async (url: string) => handler(String(url)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof MemberGuestFindPanel>> = {},
) {
  const onAdd = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <MemberGuestFindPanel
      openSearchEnabled={false}
      existingMemberIds={[]}
      atCapacity={false}
      onAdd={onAdd}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { ...utils, onAdd, onCancel };
}

function input() {
  return screen.getByRole("combobox");
}

async function type(value: string) {
  fireEvent.change(input(), { target: { value } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("the household pick-list is operable by keyboard, in the DEFAULT mode (F1)", () => {
  beforeEach(() => {
    stubFetch(() => jsonResponse({ candidates: [SAM, ELLA] }));
  });

  it("chooses the highlighted candidate on Enter instead of re-running the lookup", async () => {
    const { onAdd } = renderPanel();
    await type("household@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));

    await screen.findByRole("listbox");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Arrow to the second row, then Enter. Before the fix an `isEmailIntent &&
    // Enter` branch sat above candidate selection and always won: the fetch
    // count went 1 → 2 and no chip ever appeared.
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Ella Whittaker")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add to booking" }));
    expect(onAdd).toHaveBeenCalledWith(ELLA);
  });

  it("runs the find on Enter when there is nothing to choose from", async () => {
    renderPanel();
    await type("sam@example.com");
    fireEvent.keyDown(input(), { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      "/api/members/guest-candidates/resolve",
    );
  });
});

describe("the results list is a real combobox in both modes (F2, F17)", () => {
  it("wires every combobox attribute with open search OFF", async () => {
    stubFetch(() => jsonResponse({ candidates: [SAM, ELLA] }));
    renderPanel();
    await type("household@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    const listbox = await screen.findByRole("listbox");

    const box = input();
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(box).toHaveAttribute("aria-controls", listbox.id);
    expect(box).toHaveAttribute("aria-autocomplete", "list");
    expect(box).toHaveAttribute("aria-haspopup", "listbox");
    const active = box.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    // The active option must be a real element, and it must be the LI that
    // carries role="option" — options have to be the listbox's own children.
    const activeOption = document.getElementById(active!);
    expect(activeOption?.tagName).toBe("LI");
    expect(activeOption).toHaveAttribute("role", "option");
    expect(activeOption?.parentElement).toBe(listbox);
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });

  it("does not leave aria-controls dangling when no listbox is rendered", () => {
    stubFetch();
    renderPanel();
    expect(input()).not.toHaveAttribute("aria-controls");
    expect(input()).toHaveAttribute("aria-expanded", "false");
  });
});

describe("every outcome is announced (F4)", () => {
  it("announces a zero-result search rather than emitting an empty string", async () => {
    stubFetch(() => jsonResponse({ candidates: [] }));
    renderPanel();
    await type("nobody@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));

    expect(await screen.findByTestId("member-guest-find-message")).toHaveTextContent(
      MEMBER_GUEST_FIND_COPY.noEmailMatch,
    );
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).toHaveTextContent(MEMBER_GUEST_FIND_COPY.noEmailMatch);
  });

  it("announces the result count when there are rows", async () => {
    stubFetch(() => jsonResponse({ candidates: [SAM, ELLA] }));
    renderPanel();
    await type("household@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await screen.findByRole("listbox");
    expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent(
      "2 members found",
    );
  });
});

describe("Escape (F5)", () => {
  it("cancels out of the panel when nothing is selected", () => {
    stubFetch();
    const { onCancel } = renderPanel();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("is reachable once a chip is showing, where there is no input to press it in", async () => {
    stubFetch(() => jsonResponse({ candidates: [SAM] }));
    renderPanel();
    await type("sam@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await screen.findByRole("button", { name: "Add to booking" });
    // The chip replaces the input, so an Escape handler bound to the input could
    // never have run here.
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByTestId("member-guest-find-panel"), {
      key: "Escape",
    });
    expect(screen.getByRole("combobox")).toBeInTheDocument();
  });

  it("clears the chip first when something is selected", async () => {
    stubFetch(() => jsonResponse({ candidates: [SAM] }));
    const { onCancel } = renderPanel();
    await type("sam@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await screen.findByRole("button", { name: "Add to booking" });

    fireEvent.keyDown(screen.getByTestId("member-guest-find-panel"), {
      key: "Escape",
    });
    expect(onCancel).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Add to booking" }),
    ).not.toBeInTheDocument();
  });
});

describe("a name typed into the email-only box says so (F7)", () => {
  it("gives real feedback instead of doing nothing at all", async () => {
    stubFetch();
    renderPanel({ openSearchEnabled: false });
    await type("Sam Whittaker");
    fireEvent.keyDown(input(), { key: "Enter" });

    expect(await screen.findByTestId("member-guest-find-message")).toHaveTextContent(
      MEMBER_GUEST_FIND_COPY.nameSearchOff,
    );
    // And it never asks the server a question the server cannot answer.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still offers the Find button when the text is not an address (F18)", async () => {
    stubFetch();
    renderPanel({ openSearchEnabled: false });
    expect(screen.getByRole("button", { name: "Find" })).toBeInTheDocument();
    await type("Sam");
    // No appearing/disappearing button resizing the input mid-typing.
    expect(screen.getByRole("button", { name: "Find" })).toBeInTheDocument();
  });
});

describe("the two-character floor is enforced before the request (F6)", () => {
  it("says the query is too short instead of claiming nobody matches", async () => {
    vi.useFakeTimers();
    stubFetch(() => jsonResponse({ candidates: [] }));
    renderPanel({ openSearchEnabled: true });
    await type("s");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("member-guest-find-message")).toHaveTextContent(
      MEMBER_GUEST_FIND_COPY.minChars,
    );
    expect(
      screen.queryByText(MEMBER_GUEST_FIND_COPY.noNameMatch),
    ).not.toBeInTheDocument();
  });

  it("searches once the query is long enough", async () => {
    vi.useFakeTimers();
    stubFetch(() => jsonResponse({ candidates: [SAM, ELLA], truncated: false }));
    renderPanel({ openSearchEnabled: true });
    await type("wh");
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_SETTLE_MS);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("q=wh");
  });
});

describe("same-name advice is not circular in email mode (F8)", () => {
  const TWIN = { ...ELLA, memberId: "m-twin", firstName: "Sam", ageTier: "ADULT" as const };

  it("does not tell a booker to use the address they just typed", async () => {
    stubFetch(() => jsonResponse({ candidates: [SAM, TWIN] }));
    renderPanel();
    await type("household@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await screen.findByRole("listbox");

    expect(screen.getByText(MEMBER_GUEST_FIND_COPY.sameNameEmail)).toBeInTheDocument();
    expect(screen.queryByText(MEMBER_GUEST_FIND_COPY.sameName)).not.toBeInTheDocument();
  });

  it("keeps the mockup's wording in name mode, where the address IS new information", async () => {
    vi.useFakeTimers();
    stubFetch(() => jsonResponse({ candidates: [SAM, TWIN] }));
    renderPanel({ openSearchEnabled: true });
    await type("whit");
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_SETTLE_MS);
    });
    expect(screen.getByText(MEMBER_GUEST_FIND_COPY.sameName)).toBeInTheDocument();
  });
});

describe("the neutral refusal keeps its context and its help (F9)", () => {
  it("names the person it was about and offers the mockup's next step", () => {
    stubFetch();
    renderPanel({
      addError: "This member can't be added to this booking right now.",
      refusedCandidate: SAM,
    });
    expect(
      screen.getByText("This member can't be added to this booking right now."),
    ).toBeInTheDocument();
    expect(screen.getByText("Sam Whittaker")).toBeInTheDocument();
    expect(screen.getByText(MEMBER_GUEST_FIND_COPY.refusalHelp)).toBeInTheDocument();
  });
});

describe("somebody already in the party is refused with a reason (F16)", () => {
  it("auto-resolve produces a chip that says why it cannot be added", async () => {
    stubFetch(() => jsonResponse({ candidates: [SAM] }));
    renderPanel({ existingMemberIds: [SAM.memberId] });
    await type("sam@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));

    const addButton = await screen.findByRole("button", { name: "Add to booking" });
    expect(addButton).toBeDisabled();
    expect(screen.getByText(MEMBER_GUEST_FIND_COPY.alreadyAdded)).toBeInTheDocument();
  });

  it("says the booking is full rather than disabling silently", async () => {
    stubFetch(() => jsonResponse({ candidates: [SAM] }));
    renderPanel({ atCapacity: true });
    await type("sam@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));

    const addButton = await screen.findByRole("button", { name: "Add to booking" });
    expect(addButton).toBeDisabled();
    expect(screen.getByText(MEMBER_GUEST_FIND_COPY.atCapacity)).toBeInTheDocument();
  });
});

describe("the list is bounded and the search is visible (F14, F15)", () => {
  it("scrolls a long result set inside its own box", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      memberId: `m-${i}`,
      firstName: `First${i}`,
      lastName: `Last${i}`,
      ageTier: "ADULT" as const,
    }));
    stubFetch(() => jsonResponse({ candidates: many, truncated: true }));
    renderPanel();
    await type("household@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    const listbox = await screen.findByRole("listbox");
    expect(listbox.className).toContain("max-h-60");
    expect(listbox.className).toContain("overflow-y-auto");
    // The truncation signal never carries a count, and it is drawn exactly
    // once: #2460 announces it by appending it to the status line the panel
    // already had, rather than by putting the sentence on screen a second time.
    expect(screen.getAllByText(MEMBER_GUEST_FIND_COPY.truncated)).toHaveLength(1);
    expect(screen.queryByText(/10 of/)).not.toBeInTheDocument();
  });

  it("shows a searching state and keeps the previous rows while narrowing", async () => {
    vi.useFakeTimers();
    let resolveSecond: ((value: Response) => void) | null = null;
    let call = 0;
    stubFetch(() => {
      call += 1;
      if (call === 1) return jsonResponse({ candidates: [SAM, ELLA] });
      return new Promise<Response>((resolve) => {
        resolveSecond = resolve;
      });
    });
    renderPanel({ openSearchEnabled: true });

    await type("wh");
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_SETTLE_MS);
    });
    expect(screen.getAllByRole("option")).toHaveLength(2);

    await type("whi");
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_SETTLE_MS);
    });
    // Still two rows on screen, plus a visible "Searching…" — the list used to
    // blink out entirely on every debounced keystroke.
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getAllByText(MEMBER_GUEST_FIND_COPY.searching).length).toBeGreaterThan(0);
    await act(async () => {
      resolveSecond?.(jsonResponse({ candidates: [SAM] }));
    });
  });
});

describe("the rate-limited and error states still render", () => {
  it("shows the rate-limit sentence on a 429", async () => {
    stubFetch(() => jsonResponse({ error: "Too many requests" }, 429));
    renderPanel();
    await type("sam@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(
      await screen.findByText(MEMBER_GUEST_FIND_COPY.rateLimited),
    ).toBeInTheDocument();
  });

  it("answers a half-typed address with the SAME sentence a real miss produces", async () => {
    stubFetch();
    renderPanel();
    await type("sam@exampl");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByTestId("member-guest-find-message")).toHaveTextContent(
      MEMBER_GUEST_FIND_COPY.noEmailMatch,
    );
    // No request at all: a typing mistake is not a question about any member.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/*
  #2460 — the truncation hint is ANNOUNCED, not only drawn.

  Before this the "Keep typing to narrow this down." sentence was a bare
  paragraph under the pick-list. A booker using a screen reader heard the result
  count and then nothing: the list simply stopped, with no way to know that the
  answer was to type another letter.

  The sentence is announced by the panel's OWN status line — the permanently
  mounted `aria-live="polite"` paragraph that already carries the result count —
  and not by a second live region beside it. Two things follow, and both are
  pinned below:

  - The region is mounted and EMPTY before there is anything to say, and is the
    SAME node once there is. That is the house rule (`AGENTS.md`,
    `PolicyFeedback`, the #2244 export-truncation notice): a polite region
    injected already-populated is silently dropped by some screen-reader/browser
    pairings.
  - The sentence exists exactly ONCE on screen and once in the announcement it
    qualifies. A second `role="status"` holding the same words would read the
    hint twice in browse mode, which the repo treats as a defect in its own
    right (`hut-leaders/_components/assignment-form.tsx`).

  Mutation probes run against this block, each confirmed to turn it red: drop
  the truncation clause from `announcement`; announce a string other than
  `MEMBER_GUEST_FIND_COPY.truncated`; drop `truncated`, `candidates.length > 1`
  or `!selected` from the `showTruncationHint` gate; read `truncated` from
  RESULTS only, so it collapses while a search is in flight.
*/
describe("#2460 — the truncation hint is announced to screen readers", () => {
  const TEN = Array.from({ length: 10 }, (_, i) => ({
    memberId: `m-${i}`,
    firstName: `First${i}`,
    lastName: `Last${i}`,
    ageTier: "ADULT" as const,
  }));

  function status() {
    return screen.getByTestId("member-guest-find-status");
  }

  async function search(body: unknown) {
    stubFetch(() => jsonResponse(body));
    renderPanel();
    await type("household@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    return await screen.findByRole("listbox");
  }

  it("registers the polite region before there is anything to announce", () => {
    stubFetch();
    renderPanel();
    // Mounted on first paint, and empty: the region has to be in the
    // accessibility tree BEFORE anything lands in it.
    expect(status()).toHaveAttribute("aria-live", "polite");
    expect(status().textContent).toBe("");
  });

  it("says only the count when the results were not cut short", async () => {
    await search({ candidates: TEN, truncated: false });
    expect(status().textContent).toBe("10 members found");
    expect(screen.queryByText(MEMBER_GUEST_FIND_COPY.truncated)).not.toBeInTheDocument();
  });

  it("announces the sentence, verbatim, on the end of the count it explains", async () => {
    await search({ candidates: TEN, truncated: true });
    // Verbatim, and the only number in it is how many members ARE shown — the
    // sentence never grows a count of who was left out.
    expect(status().textContent).toBe(
      `10 members found. ${MEMBER_GUEST_FIND_COPY.truncated}`,
    );
  });

  it("leaves the visible copy exactly as it was, and does not duplicate it", async () => {
    await search({ candidates: TEN, truncated: true });
    // Still its own paragraph under the list, unchanged — the announcement is
    // an addition, not a rewrite. And still exactly one node holds the sentence
    // on its own: a second live region cloning it would read it twice.
    const drawn = screen.getAllByText(MEMBER_GUEST_FIND_COPY.truncated);
    expect(drawn).toHaveLength(1);
    expect(drawn[0]!.tagName).toBe("P");
    expect(drawn[0]!.className).toContain("text-muted-foreground");
    expect(status().contains(drawn[0]!)).toBe(false);
  });

  it("swaps the content of the region that was already there, never mounts a new one", async () => {
    stubFetch(() => jsonResponse({ candidates: TEN, truncated: true }));
    renderPanel();
    const before = status();
    expect(before.textContent).toBe("");

    await type("household@example.com");
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    await screen.findByRole("listbox");

    // Same DOM node, now populated. A fresh node here would mean the region was
    // injected already carrying the sentence, which is the case screen readers
    // drop.
    expect(status()).toBe(before);
    expect(status()).toHaveTextContent(MEMBER_GUEST_FIND_COPY.truncated);
  });

  it("drops the hint once a candidate is chosen, since the list is gone", async () => {
    await search({ candidates: TEN, truncated: true });
    expect(status()).toHaveTextContent(MEMBER_GUEST_FIND_COPY.truncated);

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    await screen.findByRole("button", { name: "Add to booking" });
    expect(status().textContent).toBe("Selected First0 Last0");
    expect(screen.queryByText(MEMBER_GUEST_FIND_COPY.truncated)).not.toBeInTheDocument();
  });

  it("keeps the hint under the list while the next keystroke's search is in flight", async () => {
    // The type-ahead deliberately leaves the previous page of rows on screen
    // while the next request runs. The sentence that explains those rows has to
    // stay with them: read from RESULTS alone it collapsed to false the moment
    // the panel went LOADING, so the hint blinked out from under a list that
    // had not changed — and was re-announced when it came back.
    vi.useFakeTimers();
    let release: (() => void) | null = null;
    let call = 0;
    stubFetch(() => {
      call += 1;
      if (call === 1) return jsonResponse({ candidates: TEN, truncated: true });
      return new Promise<Response>((resolve) => {
        release = () => resolve(jsonResponse({ candidates: TEN, truncated: true }));
      });
    });
    renderPanel({ openSearchEnabled: true });

    await type("wh");
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_SETTLE_MS);
    });
    expect(screen.getAllByText(MEMBER_GUEST_FIND_COPY.truncated)).toHaveLength(1);

    await type("whi");
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_SETTLE_MS);
    });

    // Second request issued and still unanswered, rows still drawn from the
    // previous response — and the hint still under them.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getAllByText(MEMBER_GUEST_FIND_COPY.truncated)).toHaveLength(1);

    await act(async () => {
      release?.();
    });
    expect(screen.getAllByText(MEMBER_GUEST_FIND_COPY.truncated)).toHaveLength(1);
  });
});
