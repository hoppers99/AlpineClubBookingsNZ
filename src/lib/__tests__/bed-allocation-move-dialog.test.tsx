// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BedAllocationMoveDialog,
  useBedAllocationMoveDialog,
} from "@/components/admin/bed-allocation-move-dialog";
import type { BedAllocationMovePreview } from "@/lib/bed-allocation-move";

const fetchMock = vi.fn();

const anchor = {
  allocationId: "allocation-1",
  guestName: "Ada Guest",
  stayDate: "2026-08-01",
};

const destination = {
  destinationBedId: "bed-2",
  destinationLabel: "Room Two / Bed B",
};

function preview(
  overrides: Partial<BedAllocationMovePreview> = {},
): BedAllocationMovePreview {
  return {
    digestVersion: "v1",
    digest: "v1:move-preview",
    scope: "ALLOCATION_NIGHT",
    anchor: {
      allocationId: anchor.allocationId,
      guestName: anchor.guestName,
      stayDate: anchor.stayDate,
    },
    destination: {
      bedId: destination.destinationBedId,
      label: destination.destinationLabel,
      available: true,
    },
    resolvedRowCount: 1,
    changedRowCount: 1,
    unchangedRowCount: 0,
    approvedToDraftCount: 0,
    changed: [
      {
        allocationId: anchor.allocationId,
        stayDate: anchor.stayDate,
        source: "AUTO",
        approved: false,
        sourceRoomName: "Room One",
        sourceBedName: "Bed A",
      },
    ],
    unchanged: [],
    promotions: [],
    conflicts: [],
    ...overrides,
  };
}

function response(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

function Harness({ onApplied = vi.fn() }: { onApplied?: () => void | Promise<void> }) {
  const move = useBedAllocationMoveDialog({ canEdit: true, onApplied });
  return (
    <main>
      <button
        type="button"
        onClick={() => move.openMoveDialog(anchor, destination)}
      >
        Open move
      </button>
      {move.dialog}
    </main>
  );
}

describe("BedAllocationMoveDialog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("loads one preview when its success announcement rerenders the hook owner", async () => {
    fetchMock.mockResolvedValueOnce(response(preview()));
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Open move" }));
    await screen.findByText(/1 changing, 0 unchanged, 1 total/);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/bed-allocation/allocations/move",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          anchorAllocationId: anchor.allocationId,
          destinationBedId: destination.destinationBedId,
          scope: "ALLOCATION_NIGHT",
        }),
      }),
    );
  });

  it("reports a refresh failure as post-commit after the server applied the move", async () => {
    fetchMock
      .mockResolvedValueOnce(response(preview()))
      .mockResolvedValueOnce(
        response({
          noop: false,
          movedRowCount: 1,
          promotedRowCount: 0,
          affectedNights: [anchor.stayDate],
        }),
      );
    render(<Harness onApplied={() => Promise.reject(new Error("refresh failed"))} />);

    fireEvent.click(screen.getByRole("button", { name: "Open move" }));
    await screen.findByText(/1 changing, 0 unchanged, 1 total/);
    fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Move confirmed, but the allocation board could not refresh",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "No allocation changed",
    );
  });

  it("keeps the selected scope and requires another confirmation after a stale apply", async () => {
    const personPreview = preview({
      digest: "v1:person-old",
      scope: "BOOKING_GUEST",
    });
    const refreshedPreview = preview({
      digest: "v1:person-new",
      scope: "BOOKING_GUEST",
      resolvedRowCount: 2,
      changedRowCount: 1,
      unchangedRowCount: 1,
      unchanged: [
        {
          ...preview().changed[0],
          allocationId: "allocation-2",
          stayDate: "2026-08-02",
          sourceBedName: "Bed B",
          sourceRoomName: "Room Two",
        },
      ],
    });
    fetchMock
      .mockResolvedValueOnce(response(preview()))
      .mockResolvedValueOnce(response(personPreview))
      .mockResolvedValueOnce(
        response(
          {
            error: "The move preview is stale",
            code: "STALE_PREVIEW",
            refreshedPreview,
          },
          false,
          409,
        ),
      );
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Open move" }));
    await screen.findByText(/1 changing, 0 unchanged, 1 total/);
    fireEvent.click(
      screen.getByRole("radio", { name: /This person on this booking/ }),
    );
    await screen.findByText(/1 changing, 0 unchanged, 1 total/);
    fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));

    expect(
      await screen.findByRole("button", { name: "Confirm refreshed move" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("radio", { name: /This person on this booking/ }),
    ).toBeChecked();
    expect(screen.getByText(/1 changing, 1 unchanged, 2 total/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("uses the tri-state view-only control inside the dialog", async () => {
    fetchMock.mockResolvedValueOnce(response(preview()));
    render(
      <BedAllocationMoveDialog
        open
        onOpenChange={vi.fn()}
        anchor={{ ...anchor, ...destination }}
        canEdit={false}
        onApplied={vi.fn()}
        announcePolite={vi.fn()}
        announceAssertive={vi.fn()}
      />,
    );

    expect(await screen.findByRole("button", { name: "Confirm move" })).toBeDisabled();
    expect(
      screen.getByText(/view this area but cannot make changes/i),
    ).toBeInTheDocument();
  });
});
