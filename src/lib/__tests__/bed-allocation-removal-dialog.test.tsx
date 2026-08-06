// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BedAllocationRemovalDialog,
  type BedAllocationRemovalDialogAnchor,
  useBedAllocationRemovalDialog,
} from "@/components/admin/bed-allocation-removal-dialog";

const fetchMock = vi.fn();

const anchorA: BedAllocationRemovalDialogAnchor = {
  allocations: [
    {
      allocationId: "alloc-a1",
      bookingId: "booking-a",
      bookingGuestId: "guest-a",
      lodgeId: "lodge-a",
      stayDate: "2026-08-01",
    },
  ],
  lodgeId: "lodge-a",
  lodgeName: "Lodge Alpha",
  window: { from: "2026-08-01", to: "2026-08-03" },
  guestName: "Ada Guest",
  initialScope: "ALLOCATION",
  initialCategories: ["AUTO_DRAFT"],
};

const anchorB: BedAllocationRemovalDialogAnchor = {
  ...anchorA,
  allocations: [
    {
      allocationId: "alloc-b1",
      bookingId: "booking-b",
      bookingGuestId: "guest-b",
      lodgeId: "lodge-b",
      stayDate: "2026-08-02",
    },
  ],
  lodgeId: "lodge-b",
  lodgeName: "Lodge Beta",
  guestName: "Bea Guest",
};

const twoNightAnchor: BedAllocationRemovalDialogAnchor = {
  ...anchorA,
  allocations: [
    anchorA.allocations[0],
    { ...anchorA.allocations[0], allocationId: "alloc-a2", stayDate: "2026-08-02" },
  ],
};

function preview(
  anchor: BedAllocationRemovalDialogAnchor = anchorA,
  matchedRowCount = 1,
) {
  const allocation = anchor.allocations[0];
  return {
    digestVersion: "v1",
    digest: `v1:${allocation.allocationId}`,
    scope: {
      type: "ALLOCATION",
      ...allocation,
    },
    context: {
      lodgeId: anchor.lodgeId,
      lodgeName: anchor.lodgeName ?? anchor.lodgeId,
      from: allocation.stayDate,
      to: allocation.stayDate,
      bookingId: allocation.bookingId,
      bookingGuestId: allocation.bookingGuestId,
      guestName: anchor.guestName ?? null,
      anchorNight: allocation.stayDate,
    },
    categories: {
      AUTO_DRAFT: matchedRowCount,
      MANUAL_DRAFT: 0,
      APPROVED: 0,
    },
    matchedRowCount,
    affectedBookingCount: matchedRowCount ? 1 : 0,
    affectedNights: matchedRowCount ? [allocation.stayDate] : [],
    promotions: [],
    reopenedBookings: [],
  };
}

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof BedAllocationRemovalDialog>> = {},
) {
  const onOpenChange = vi.fn();
  const onApplied = vi.fn();
  const props: React.ComponentProps<typeof BedAllocationRemovalDialog> = {
    open: true,
    onOpenChange,
    anchor: anchorA,
    canEdit: true,
    onApplied,
    ...overrides,
  };
  const rendered = render(<BedAllocationRemovalDialog {...props} />);
  return { ...rendered, props, onOpenChange, onApplied };
}

describe("BedAllocationRemovalDialog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("keeps live regions mounted and names the lodge before preview", () => {
    renderDialog();

    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.getByText("Lodge Alpha")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Remove reviewed allocations" }),
    ).toBeDisabled();
  });

  it("clears a successful preview before showing a failed re-preview", async () => {
    fetchMock
      .mockResolvedValueOnce(response(preview()))
      .mockResolvedValueOnce(response({ error: "Preview refused" }, false, 409));
    renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await screen.findByText(/matching allocation/);
    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));

    expect(screen.queryByText(/matching allocation/)).not.toBeInTheDocument();
    expect(await screen.findByText("Preview refused")).toBeInTheDocument();
  });

  it("clears preview, error, and status when the explicit night changes", async () => {
    fetchMock.mockResolvedValueOnce(response(preview()));
    renderDialog({ anchor: twoNightAnchor });

    const nightSelect = screen.getByLabelText("Removal night");
    nightSelect.focus();
    fireEvent.keyDown(nightSelect, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "2026-08-01" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await screen.findByText(/matching allocation/);
    expect(screen.getByText(/Preview ready/)).toBeInTheDocument();

    nightSelect.focus();
    fireEvent.keyDown(nightSelect, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("option", { name: "2026-08-02" }));

    expect(screen.queryByText(/matching allocation/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Preview ready/)).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  });

  it("ignores an old anchor's preview response after switching anchors", async () => {
    const pending = deferred<ReturnType<typeof response>>();
    fetchMock.mockReturnValueOnce(pending.promise);
    const rendered = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    rendered.rerender(
      <BedAllocationRemovalDialog
        {...rendered.props}
        anchor={anchorB}
      />,
    );
    await act(async () => pending.resolve(response(preview(anchorA))));

    expect(screen.getByText("Lodge Beta")).toBeInTheDocument();
    expect(screen.queryByText(/matching allocation/)).not.toBeInTheDocument();
  });

  it("guards a same-tick double apply with one PUT", async () => {
    fetchMock.mockResolvedValueOnce(response(preview()));
    const apply = deferred<ReturnType<typeof response>>();
    fetchMock.mockReturnValueOnce(apply.promise);
    const { onApplied } = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await screen.findByText(/matching allocation/);
    const remove = screen.getByRole("button", {
      name: "Remove reviewed allocations",
    });
    fireEvent.click(remove);
    fireEvent.click(remove);

    expect(
      fetchMock.mock.calls.filter((call) => call[1]?.method === "PUT"),
    ).toHaveLength(1);
    await act(async () =>
      apply.resolve(
        response({
          removedRowCount: 1,
          promotedRowCount: 0,
          affectedBookingCount: 1,
          affectedNights: ["2026-08-01"],
        }),
      ),
    );
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
  });

  it("does not let an old apply response close a newly opened anchor", async () => {
    fetchMock.mockResolvedValueOnce(response(preview()));
    const apply = deferred<ReturnType<typeof response>>();
    fetchMock.mockReturnValueOnce(apply.promise);
    const rendered = renderDialog();

    fireEvent.click(screen.getByRole("button", { name: "Preview removal" }));
    await screen.findByText(/matching allocation/);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove reviewed allocations" }),
    );
    rendered.rerender(
      <BedAllocationRemovalDialog {...rendered.props} open={false} />,
    );
    rendered.rerender(
      <BedAllocationRemovalDialog {...rendered.props} anchor={anchorB} />,
    );

    await act(async () =>
      apply.resolve(
        response({
          removedRowCount: 1,
          promotedRowCount: 0,
          affectedBookingCount: 1,
          affectedNights: ["2026-08-01"],
        }),
      ),
    );

    expect(rendered.onApplied).toHaveBeenCalledTimes(1);
    expect(rendered.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByText("Lodge Beta")).toBeInTheDocument();
  });

  it("returns focus to the shared entry trigger after cancel", async () => {
    function Harness() {
      const [applied] = useState(vi.fn());
      const removal = useBedAllocationRemovalDialog({
        canEdit: true,
        onApplied: applied,
      });
      return (
        <>
          <button
            type="button"
            onClick={() => removal.openRemovalDialog(anchorA)}
          >
            Open removal
          </button>
          {removal.dialog}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open removal" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
