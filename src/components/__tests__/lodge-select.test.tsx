// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ALL_LODGES, LodgeSelect } from "../lodge-select";

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
