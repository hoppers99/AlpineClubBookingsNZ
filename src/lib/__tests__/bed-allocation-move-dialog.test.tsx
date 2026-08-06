// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
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

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const appliedResult = {
  noop: false,
  movedRowCount: 1,
  promotedRowCount: 0,
  affectedNights: [anchor.stayDate],
};

function Harness({ onApplied = vi.fn() }: { onApplied?: () => void | Promise<void> }) {
  const move = useBedAllocationMoveDialog({ canEdit: true, onApplied });
  return (
    <main>
      <button
        type="button"
        data-bed-allocation-focus-id={anchor.allocationId}
        onClick={(event) =>
          move.openMoveDialog(anchor, destination, event.currentTarget)
        }
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
        response(appliedResult),
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

  it("restores focus to the stable originating allocation control on cancel", async () => {
    fetchMock.mockResolvedValueOnce(response(preview()));
    render(<Harness />);

    const origin = screen.getByRole("button", { name: "Open move" });
    fireEvent.click(origin);
    await screen.findByText(/1 changing, 0 unchanged, 1 total/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(origin).toHaveFocus());
  });

  it("restores focus by allocation identity after a successful refresh replaces the control", async () => {
    function RefreshHarness() {
      const [version, setVersion] = useState(0);
      const move = useBedAllocationMoveDialog({
        canEdit: true,
        onApplied: async () => setVersion((current) => current + 1),
      });
      return (
        <main>
          <button
            key={version}
            type="button"
            data-bed-allocation-focus-id={anchor.allocationId}
            onClick={(event) =>
              move.openMoveDialog(anchor, destination, event.currentTarget)
            }
          >
            Open move version {version}
          </button>
          {move.dialog}
        </main>
      );
    }

    fetchMock
      .mockResolvedValueOnce(response(preview()))
      .mockResolvedValueOnce(response(appliedResult));
    render(<RefreshHarness />);

    fireEvent.click(
      screen.getByRole("button", { name: "Open move version 0" }),
    );
    await screen.findByText(/1 changing, 0 unchanged, 1 total/);
    fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));

    const replacement = await screen.findByRole("button", {
      name: "Open move version 1",
    });
    await waitFor(() => expect(replacement).toHaveFocus());
  });

  it("ignores same-tick duplicate confirmation and blocks close while apply is pending", async () => {
    const pendingApply = deferred<ReturnType<typeof response>>();
    fetchMock
      .mockResolvedValueOnce(response(preview()))
      .mockImplementationOnce(() => pendingApply.promise);
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Open move" }));
    await screen.findByText(/1 changing, 0 unchanged, 1 total/);
    const confirm = screen.getByRole("button", { name: "Confirm move" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => pendingApply.resolve(response(appliedResult)));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("fences an old apply completion from a newly opened target", async () => {
    const pendingApply = deferred<ReturnType<typeof response>>();
    const destinationB = {
      destinationBedId: "bed-3",
      destinationLabel: "Room Three / Bed C",
    };

    function RetargetHarness() {
      const onApplied = vi.fn();
      const move = useBedAllocationMoveDialog({ canEdit: true, onApplied });
      return (
        <main>
          <button
            type="button"
            data-testid="open-a"
            onClick={(event) =>
              move.openMoveDialog(anchor, destination, event.currentTarget)
            }
          >
            Open A
          </button>
          <button
            type="button"
            data-testid="open-b"
            onClick={(event) =>
              move.openMoveDialog(anchor, destinationB, event.currentTarget)
            }
          >
            Open B
          </button>
          {move.dialog}
        </main>
      );
    }

    fetchMock
      .mockResolvedValueOnce(response(preview()))
      .mockImplementationOnce(() => pendingApply.promise)
      .mockResolvedValueOnce(
        response(
          preview({
            digest: "v1:target-b",
            destination: {
              bedId: destinationB.destinationBedId,
              label: destinationB.destinationLabel,
              available: true,
            },
          }),
        ),
      );
    render(<RetargetHarness />);

    fireEvent.click(screen.getByTestId("open-a"));
    await screen.findByText(/1 changing, 0 unchanged, 1 total/);
    fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));
    fireEvent.click(screen.getByTestId("open-b"));
    await screen.findByRole("heading", {
      name: `Move ${anchor.guestName} to ${destinationB.destinationLabel}`,
    });

    await act(async () => pendingApply.resolve(response(appliedResult)));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: `Move ${anchor.guestName} to ${destinationB.destinationLabel}`,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No allocation changed/)).not.toBeInTheDocument();
  });

  it("announces preview errors once through the permanent assertive region", async () => {
    fetchMock.mockResolvedValueOnce(
      response({ error: "Destination no longer exists" }, false, 409),
    );
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Open move" }));
    await screen.findByText("Destination no longer exists");

    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toHaveTextContent(
      "Move preview failed. Destination no longer exists",
    );
    expect(alerts[1].querySelector('[role="presentation"]')).toHaveTextContent(
      "Destination no longer exists",
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
