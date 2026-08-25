// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ALL_LODGES, CLOSED_SUFFIX, LodgeSelect } from "../lodge-select";

const TWO_LODGES = [
  { id: "lodge-1", name: "Alpine Lodge" },
  { id: "lodge-2", name: "River Lodge" },
];

// ADR-002 single-lodge presentation rule: no lodge selector renders while
// fewer than two lodges are offered; it renders once a second lodge exists.
describe("LodgeSelect", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders nothing and reports the sole lodge with one lodge", () => {
    const onChange = vi.fn();
    const { container } = render(
      <LodgeSelect
        lodges={[{ id: "lodge-1", name: "Alpine Lodge" }]}
        value={null}
        onChange={onChange}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(onChange).toHaveBeenCalledWith("lodge-1", "auto");
  });

  it("renders nothing and reports null with no lodges", () => {
    const onChange = vi.fn();
    const { container } = render(
      <LodgeSelect lodges={[]} value={"stale"} onChange={onChange} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(onChange).toHaveBeenCalledWith(null, "auto");
  });

  it("renders a labelled selector once a second lodge exists", () => {
    const onChange = vi.fn();
    render(
      <LodgeSelect lodges={TWO_LODGES} value="lodge-2" onChange={onChange} />,
    );

    expect(screen.getByText("Lodge")).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(screen.getByText("River Lodge")).toBeInTheDocument();
  });

  it("defaults the selection to the first lodge when none is chosen", () => {
    const onChange = vi.fn();
    render(<LodgeSelect lodges={TWO_LODGES} value={null} onChange={onChange} />);

    expect(onChange).toHaveBeenCalledWith("lodge-1", "auto");
  });

  it("holds off normalising the selection while options are loading", () => {
    const onChange = vi.fn();
    const { container } = render(
      <LodgeSelect
        lodges={[]}
        value="lodge-from-url"
        onChange={onChange}
        loading
      />,
    );

    // A caller-provided initial selection (e.g. an ADR-003 hub link) must
    // survive until the options arrive.
    expect(container).toBeEmptyDOMElement();
    expect(onChange).not.toHaveBeenCalled();
  });
});

/*
 * #2701 — "All lodges" is a CHOICE, and the default is a real lodge.
 *
 * The three situations `null` used to cover are separated here at the source.
 * A deliberate club-wide view has its own value that survives normalisation; a
 * page that has not chosen anything still defaults to a concrete lodge; and a
 * caller that never opted in cannot end up club-wide at all, however the value
 * arrived.
 */
describe("LodgeSelect — explicit All lodges (#2701)", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps an explicit All lodges selection instead of normalising it to the first lodge", () => {
    const onChange = vi.fn();
    render(
      <LodgeSelect
        lodges={TWO_LODGES}
        value={ALL_LODGES}
        onChange={onChange}
        allowAllLodges
      />,
    );

    // MUTATION PROBE: drop the `allowAllLodges && value === ALL_LODGES` early
    // return from the normalising effect and this fails — the deliberate
    // club-wide view would be silently replaced by lodge one, which is the
    // whole reason club-wide was unreachable before this issue.
    expect(onChange).not.toHaveBeenCalled();
    // The trigger shows the chosen option, so the item really is one of the
    // options and not merely an accepted value.
    expect(screen.getByText("All lodges")).toBeInTheDocument();
  });

  it("still defaults an unresolved selection to a real lodge, never to All lodges", () => {
    const onChange = vi.fn();
    render(
      <LodgeSelect
        lodges={TWO_LODGES}
        value={null}
        onChange={onChange}
        allowAllLodges
      />,
    );

    expect(onChange).toHaveBeenCalledWith("lodge-1", "auto");
    expect(onChange).not.toHaveBeenCalledWith(ALL_LODGES, expect.anything());
  });

  it("normalises All lodges away for a caller that did not opt in", () => {
    // Every other page in the tree passes no `allowAllLodges`, so a sentinel
    // arriving from a URL there must not turn that page club-wide.
    const onChange = vi.fn();
    render(
      <LodgeSelect lodges={TWO_LODGES} value={ALL_LODGES} onChange={onChange} />,
    );

    expect(onChange).toHaveBeenCalledWith("lodge-1", "auto");
  });

  it("holds an unvalidated deep link during an outage, then normalises it after a successful response", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <LodgeSelect
        lodges={[]}
        value="lodge-from-link"
        onChange={onChange}
        deferDefaultSelection
      />,
    );

    expect(onChange).not.toHaveBeenCalled();

    rerender(
      <LodgeSelect
        lodges={TWO_LODGES}
        value="lodge-from-link"
        onChange={onChange}
      />,
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("lodge-1", "auto");
  });

  it("normalises All lodges away in a single-lodge club (ADR-002)", () => {
    // There is no club-wide view to choose when there is one lodge, and the
    // selector does not render at all.
    const onChange = vi.fn();
    const { container } = render(
      <LodgeSelect
        lodges={[{ id: "lodge-1", name: "Alpine Lodge" }]}
        value={ALL_LODGES}
        onChange={onChange}
        allowAllLodges
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(onChange).toHaveBeenCalledWith("lodge-1", "auto");
  });

  it("holds the first-lodge default off while the caller is still resolving one", () => {
    // The bed-allocation board sets this while a deep-linked booking's lodge is
    // still unknown. Defaulting to lodge one in that window is exactly how a
    // lodge-B booking used to land on lodge A's board (#2701).
    const onChange = vi.fn();
    render(
      <LodgeSelect
        lodges={TWO_LODGES}
        value={null}
        onChange={onChange}
        deferDefaultSelection
      />,
    );

    expect(onChange).not.toHaveBeenCalled();
  });
});

/*
 * The source of a change is reported, not inferred.
 *
 * The board treats "the admin picked a lodge" as browsing away from a focused
 * booking, and used to infer that from the values alone — which cannot tell a
 * default apart from a deliberate pick, and got the first pick from an
 * unresolved selection wrong in the other direction.
 */
describe("LodgeSelect — change source (#2701)", () => {
  beforeAll(() => {
    // Radix Select opens on a keyboard key, but its content still measures and
    // scrolls; jsdom implements neither of these.
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  afterEach(() => {
    cleanup();
  });

  it("reports a pick from the open menu as a user change", () => {
    const onChange = vi.fn();
    render(
      <LodgeSelect
        lodges={TWO_LODGES}
        value="lodge-1"
        onChange={onChange}
        allowAllLodges
      />,
    );

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("option", { name: "All lodges" }));

    expect(onChange).toHaveBeenCalledWith(ALL_LODGES, "user");
  });

  it("offers every lodge alongside All lodges", () => {
    const onChange = vi.fn();
    render(
      <LodgeSelect
        lodges={TWO_LODGES}
        value="lodge-1"
        onChange={onChange}
        allowAllLodges
      />,
    );

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });

    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["All lodges", "Alpine Lodge", "River Lodge"]);
  });
});

/*
 * #221 — configuring a lodge that is not open yet.
 *
 * A lodge created through the setup flow starts INACTIVE, and the whole period
 * before it opens is when its rooms, beds, lockers, seasons, rates and chores
 * get made. The five full editors therefore ask `useLodgeOptions` for the
 * CONFIGURATION scope, whose list keeps closed lodges and carries `active`.
 *
 * That is only half the fix. The other half is here, and it is the half that
 * was silently wrong: ADR-002's normaliser counted the whole list, so on a club
 * with one open lodge plus the one being set up it saw a single-lodge club,
 * rendered no selector, and reported the OPEN lodge through `onChange` — after
 * which every write the operator made landed on the wrong lodge with nothing on
 * screen saying so.
 *
 * Three rules, and they have to hold together: a closed lodge is honoured when
 * NAMED, never chosen when not, and never invisible when it is the one in use.
 */
describe("LodgeSelect — a lodge that is not open for booking (#221)", () => {
  const OPEN_AND_CLOSED = [
    { id: "lodge-1", name: "Alpine Lodge", active: true },
    { id: "lodge-2", name: "New Lodge", active: false },
  ];

  beforeAll(() => {
    if (!Element.prototype.hasPointerCapture) {
      Element.prototype.hasPointerCapture = () => false;
    }
    if (!Element.prototype.scrollIntoView) {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  afterEach(() => {
    cleanup();
  });

  it("keeps a named closed lodge instead of substituting the open one", () => {
    // The ?lodgeId= case: the operator followed a configuration link from the
    // setup flow or the lodge hub. One open lodge is ONE open lodge, so the
    // sole-lodge rule would otherwise fire and retarget the page.
    const onChange = vi.fn();
    render(
      <LodgeSelect
        lodges={OPEN_AND_CLOSED}
        value="lodge-2"
        onChange={onChange}
      />,
    );

    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows which lodge that is, labelled, rather than staying silent", () => {
    // Two configurable lodges is not a single-lodge club, so the selector
    // renders — and the label is what tells the operator the building they are
    // filling with rooms is the closed one.
    render(
      <LodgeSelect
        lodges={OPEN_AND_CLOSED}
        value="lodge-2"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox")).toBeInTheDocument();
    expect(
      screen.getByText(`New Lodge ${CLOSED_SUFFIX}`),
    ).toBeInTheDocument();
  });

  it("labels the closed lodge in the open menu and leaves the open one plain", () => {
    render(
      <LodgeSelect
        lodges={OPEN_AND_CLOSED}
        value="lodge-1"
        onChange={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });

    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Alpine Lodge", `New Lodge ${CLOSED_SUFFIX}`]);
  });

  it("auto-defaults to an OPEN lodge when nothing was named", () => {
    // No ?lodgeId=. ADR-002's default is unchanged and still chooses among open
    // lodges only, so arriving at /admin/chores from the nav cannot silently
    // put an admin inside a lodge nobody can book.
    const onChange = vi.fn();
    render(
      <LodgeSelect lodges={OPEN_AND_CLOSED} value={null} onChange={onChange} />,
    );

    expect(onChange).toHaveBeenCalledWith("lodge-1", "auto");
  });

  it("never auto-selects a closed lodge, even when it is first in the list", () => {
    /*
      MUTATION PROBE: make the normaliser choose from `lodges` rather than from
      the open ones (either branch) and this fails — an admin who named nothing
      is put inside a closed lodge, which is the defect in the other direction:
      writes land somewhere the operator never asked for, and here they would
      not even have followed a link to get there.
    */
    const onChange = vi.fn();
    render(
      <LodgeSelect
        lodges={[
          { id: "lodge-2", name: "New Lodge", active: false },
          { id: "lodge-1", name: "Alpine Lodge", active: true },
        ]}
        value={null}
        onChange={onChange}
      />,
    );

    expect(onChange).toHaveBeenCalledWith("lodge-1", "auto");
    expect(onChange).not.toHaveBeenCalledWith("lodge-2", expect.anything());
  });

  it("normalises a STALE closed id away, because nothing named it", () => {
    // A closed lodge that is not in the list at all is not a deliberate
    // selection — it is a link to a lodge that has since been deleted, and the
    // ordinary stale-value rule still applies.
    const onChange = vi.fn();
    render(
      <LodgeSelect lodges={OPEN_AND_CLOSED} value="gone" onChange={onChange} />,
    );

    expect(onChange).toHaveBeenCalledWith("lodge-1", "auto");
  });

  it("names the scope instead of falling silent when the only lodge is closed", () => {
    // The suppression rule is only safe while it is REDUNDANT, and standing on
    // a closed lodge it is not.
    render(
      <LodgeSelect
        lodges={[{ id: "lodge-2", name: "New Lodge", active: false }]}
        value="lodge-2"
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("lodge-scope-line").textContent).toBe(
      `Lodge: New Lodge ${CLOSED_SUFFIX}`,
    );
  });

  it("still renders nothing for an ordinary single OPEN lodge", () => {
    // ADR-002, untouched: the scope line is for the closed case alone.
    const { container } = render(
      <LodgeSelect
        lodges={[{ id: "lodge-1", name: "Alpine Lodge", active: true }]}
        value="lodge-1"
        onChange={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
