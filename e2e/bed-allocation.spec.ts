import { type BrowserContext, expect, test } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { DEMO_BOOKING_WINDOWS, E2E_ADMIN } from "./helpers/fixtures";
import { personas } from "./helpers/personas";

// High row (docs/END_TO_END_TEST_MATRIX.md): "Approve a review-flagged booking,
// then allocate its guests to specific beds." The seeded AWAITING_REVIEW booking
// bReview (owner Ken King, adminReviewStatus PENDING, on a RELATIVE future
// window — DEMO_BOOKING_WINDOWS.kenReview, prisma/demo-seed.ts, issue #2117) is
// approved through the admin approvals panel, then Ken's
// guest is placed on a specific bed via the manual Select + Allocate path (NOT
// drag-and-drop) on the bed-allocation board, and the manual draft placement is
// approved.
//
// Auto-allocation is turned OFF for this run: the E2E stack seeds no
// BedAllocationSettings row, so it defaults ON, and approval's
// reconcileBedAllocationsForBooking would otherwise auto-place Ken (removing him
// from the "awaiting allocation" bucket the manual path drives). The setting is
// restored afterwards. No other spec touches bed allocation.
test.describe.configure({ mode: "serial" });

let adminContext: BrowserContext;

function addUtcDays(dateOnly: string, days: number) {
  const date = new Date(`${dateOnly}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

test.beforeAll(async ({ browser }) => {
  // Reuse the E2E admin session saved once in auth.setup.ts instead of a fresh
  // per-spec login (#1779).
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });

  // Disable auto-allocation so approval parks Ken in the manual bucket.
  const disabled = await adminContext.request.put(
    "/api/admin/bed-allocation/settings",
    { data: { autoAllocationEnabled: false } },
  );
  expect(
    disabled.ok(),
    `disable auto-allocation (${disabled.status()})`,
  ).toBeTruthy();
});

test.afterAll(async () => {
  try {
    if (adminContext) {
      // Restore the default (schema default is true).
      await adminContext.request.put("/api/admin/bed-allocation/settings", {
        data: { autoAllocationEnabled: true },
      });
    }
  } finally {
    await adminContext?.close();
  }
});

test("an admin approves a review-flagged booking then allocates a bed to its guest", async () => {
  const page = await adminContext.newPage();

  // ── Approve Ken King's review-flagged booking ──
  // /admin/booking-approvals redirects to /admin/booking-requests?tab=approvals;
  // the approvals panel defaults to the PENDING filter, where Ken's card sits.
  await page.goto("/admin/booking-approvals");
  await expect(page).toHaveURL(/\/admin\/booking-requests/);
  await expect(
    page.getByText("Ken King", { exact: true }).first(),
  ).toBeVisible({ timeout: 30_000 });

  // "Approve" (exact) so it never matches the "Approved" status-filter button.
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  // #1790: the approve action now opens a notify-choice dialog; confirm the
  // default notify path ("Approve and email member") to complete the approval.
  await page
    .getByRole("button", { name: "Approve and email member" })
    .click();
  await expect(page.getByText("Booking approved.")).toBeVisible();

  // ── Allocate Ken's guest to Bunk Room A / A1 via Select + Allocate ──
  // Board window matches Ken's RELATIVE seeded booking (issue #2117).
  const ken = DEMO_BOOKING_WINDOWS.kenReview;
  await page.goto(
    `/admin/bed-allocation?from=${ken.checkIn}&to=${ken.checkOut}`,
  );
  await expect(
    page.getByRole("heading", { name: "Bed Allocation" }),
  ).toBeVisible();

  // Ken's guest chip in the "awaiting allocation" bucket. Both the booking card
  // and the inner guest chip carry "Ken King" + an Allocate button, so .last()
  // resolves to the innermost (the guest chip).
  const kenChip = page
    .locator("div")
    .filter({ hasText: "Ken King" })
    .filter({ has: page.getByRole("button", { name: "Allocate" }) })
    .last();
  await expect(kenChip).toBeVisible({ timeout: 30_000 });

  // Open the grouped bed Select (Radix combobox, room label + bed option) and
  // choose a free bed, then Allocate.
  await kenChip.getByRole("combobox").click();
  await page
    .getByRole("group", { name: "Bunk Room A" })
    .getByRole("option", { name: "A1", exact: true })
    .click();
  await kenChip.getByRole("button", { name: "Allocate" }).click();
  await expect(page.getByText("Allocation saved")).toBeVisible();

  // The board now shows Ken on a bed as a MANUAL, still-Draft allocation. "Draft"
  // is asserted exact so it never matches the "N draft allocations to approve"
  // summary badge (lowercase "draft").
  await expect(page.getByText("Ken King").first()).toBeVisible();
  await expect(page.getByText("MANUAL").first()).toBeVisible();
  await expect(page.getByText("Draft", { exact: true }).first()).toBeVisible();

  // ── Approve the visible draft allocations ──
  await page.getByRole("button", { name: "Approve Visible" }).click();
  await expect(page.getByText("Allocations approved")).toBeVisible();
  await expect(page.getByText("Approved", { exact: true }).first()).toBeVisible();

  await page.close();
});

test("existing-chip pointer and keyboard drops preserve dates, while keyboard cancel is silent", async ({}, testInfo) => {
  const ken = DEMO_BOOKING_WINDOWS.kenReview;
  // Include the checkout date as one extra visible column so the pointer can
  // hover horizontally over a date Ken is not allocated on. Existing-chip
  // semantics must still snap back to the persisted source nights.
  const extendedTo = addUtcDays(ken.checkOut, 1);
  const dashboardPath = `/api/admin/bed-allocation?from=${ken.checkIn}&to=${extendedTo}`;
  const dashboard = await adminContext.request.get(dashboardPath);
  expect(dashboard.ok(), `read the board (${dashboard.status()})`).toBeTruthy();
  const payload = (await dashboard.json()) as {
    rooms: Array<{
      name: string;
      active: boolean;
      beds: Array<{ id: string; name: string; active: boolean }>;
    }>;
    allocations: Array<{
      id: string;
      bookingId: string;
      bookingGuestId: string;
      bedId: string;
      stayDate: string;
      guestName: string;
    }>;
    custodianHolds: Array<{ bedId: string; nights: string[] }>;
  };
  const kensAllocations = payload.allocations
    .filter((allocation) => allocation.guestName.includes("Ken"))
    .sort((left, right) => left.stayDate.localeCompare(right.stayDate));
  expect(kensAllocations.length).toBeGreaterThan(0);
  const originalDates = kensAllocations.map(
    (allocation) => allocation.stayDate,
  );
  const occupiedKeys = new Set(
    payload.allocations.map(
      (allocation) => `${allocation.bedId}:${allocation.stayDate}`,
    ),
  );
  const heldKeys = new Set(
    payload.custodianHolds.flatMap((hold) =>
      hold.nights.map((night) => `${hold.bedId}:${night}`),
    ),
  );
  const destination = payload.rooms
    .filter((room) => room.active)
    .flatMap((room) =>
      room.beds.map((bed) => ({ ...bed, roomName: room.name })),
    )
    .find(
      (bed) =>
        bed.active &&
        bed.id !== kensAllocations[0].bedId &&
        originalDates.every(
          (night) =>
            !occupiedKeys.has(`${bed.id}:${night}`) &&
            !heldKeys.has(`${bed.id}:${night}`),
        ),
    );
  expect(destination, "a free destination bed exists").toBeTruthy();
  const originalBedIds = new Set(
    kensAllocations.map((allocation) => allocation.bedId),
  );
  expect(
    originalBedIds.size,
    "the seeded full-stay placement starts on one bed",
  ).toBe(1);
  const originalBedId = [...originalBedIds][0];
  if (!originalBedId) {
    throw new Error("Ken's seeded full-stay placement has no source bed");
  }
  const allocationIds = kensAllocations.map((allocation) => allocation.id);

  const page = await adminContext.newPage();
  let scenarioError: unknown;
  try {
    const moveRequests: Array<{
      allocationIds: string[];
      bedId: string;
      stayDate?: string;
    }> = [];
    page.on("request", (request) => {
      if (
        request.method() === "PATCH" &&
        new URL(request.url()).pathname ===
          "/api/admin/bed-allocation/allocations"
      ) {
        moveRequests.push(
          request.postDataJSON() as {
            allocationIds: string[];
            bedId: string;
            stayDate?: string;
          },
        );
      }
    });
    await page.goto(`/admin/bed-allocation?from=${ken.checkIn}&to=${extendedTo}`);

    const dragHandle = () =>
      page
      .getByRole("button", {
        name: /Drag Ken King to another bed; original lodge night .* will be kept/,
      })
      .first();
    const targetRow = () =>
      page
      .getByRole("row")
      .filter({ has: page.getByText(destination!.name, { exact: true }) });
    const targetCell = () =>
      targetRow().locator(`td[data-stay-date="${ken.checkOut}"]`);
    const preview = () =>
      page.getByText(
        `to ${destination!.roomName} / ${destination!.name}, snapped to original lodge night`,
        { exact: false },
      );

    // Pointer preview + cancel: real sensor wiring, no request.
    await targetCell().scrollIntoViewIfNeeded();
    await dragHandle().scrollIntoViewIfNeeded();
    const from = await dragHandle().boundingBox();
    const to = await targetCell().boundingBox();
    const dragged = await dragHandle().locator("xpath=..").boundingBox();
    expect(from).toBeTruthy();
    expect(to).toBeTruthy();
    expect(dragged).toBeTruthy();
    const viewport = page.viewportSize();
    expect(viewport, "the pointer scenario has a fixed viewport").toBeTruthy();
    for (const [label, box] of [
      ["drag handle", from],
      ["target cell", to],
    ] as const) {
      const center = {
        x: box!.x + box!.width / 2,
        y: box!.y + box!.height / 2,
      };
      expect(
        center.x,
        `${label} centre is inside the viewport`,
      ).toBeGreaterThanOrEqual(0);
      expect(center.x, `${label} centre is inside the viewport`).toBeLessThan(
        viewport!.width,
      );
      expect(
        center.y,
        `${label} centre is inside the viewport`,
      ).toBeGreaterThanOrEqual(0);
      expect(center.y, `${label} centre is inside the viewport`).toBeLessThan(
        viewport!.height,
      );
    }
    // DndContext uses closestCenter, so preserve the handle-to-card-centre grab
    // offset and aim the dragged CARD's centre at the destination cell. If the
    // offset would put the cursor just outside that cell, clamp it one pixel
    // inside while staying as close as possible to the ideal alignment.
    const idealTargetPointer = {
      x:
        to!.x +
        to!.width / 2 +
        (from!.x + from!.width / 2 - (dragged!.x + dragged!.width / 2)),
      y:
        to!.y +
        to!.height / 2 +
        (from!.y + from!.height / 2 - (dragged!.y + dragged!.height / 2)),
    };
    const targetPointer = {
      x: Math.min(
        Math.max(idealTargetPointer.x, to!.x + 1),
        to!.x + to!.width - 1,
      ),
      y: Math.min(
        Math.max(idealTargetPointer.y, to!.y + 1),
        to!.y + to!.height - 1,
      ),
    };
    expect(
      targetPointer.x,
      "adjusted pointer x stays inside the target cell",
    ).toBeGreaterThanOrEqual(to!.x);
    expect(
      targetPointer.x,
      "adjusted pointer x stays inside the target cell",
    ).toBeLessThan(to!.x + to!.width);
    expect(
      targetPointer.y,
      "adjusted pointer y stays inside the target cell",
    ).toBeGreaterThanOrEqual(to!.y);
    expect(
      targetPointer.y,
      "adjusted pointer y stays inside the target cell",
    ).toBeLessThan(to!.y + to!.height);
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetPointer.x, targetPointer.y, {
      steps: 12,
    });
    await expect(preview()).toBeVisible();
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(() => moveRequests.length).toBe(0);

    // Pointer success: release over the real cell, then prove the page emitted
    // the date-free PATCH and the server persisted the original nights.
    await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetPointer.x, targetPointer.y, {
      steps: 12,
    });
    await expect(preview()).toBeVisible();
    await page.mouse.up();
    await expect(page.getByText("Visible guest nights moved")).toBeVisible({
      timeout: 30_000,
    });
    expect(moveRequests).toHaveLength(1);
    expect(moveRequests[0]).toEqual({
      allocationIds,
      bedId: destination!.id,
    });
    expect(moveRequests[0]).not.toHaveProperty("stayDate");

    const readPersisted = async () => {
      const response = await adminContext.request.get(dashboardPath);
      expect(
        response.ok(),
        `read persisted board (${response.status()})`,
      ).toBeTruthy();
      const current = (await response.json()) as typeof payload;
      return current.allocations
        .filter((allocation) => allocation.guestName.includes("Ken"))
        .sort((left, right) => left.stayDate.localeCompare(right.stayDate));
    };
    let persisted = await readPersisted();
    expect(persisted.map((allocation) => allocation.stayDate)).toEqual(
      originalDates,
    );
    expect(
      persisted.every(
        (allocation) => allocation.bedId === destination!.id,
      ),
    ).toBe(true);

    // Restore the seeded bed through the service before exercising the keyboard
    // sensor. This keeps the fixture deterministic and prevents the successful
    // pointer proof from deciding the keyboard source/destination geometry.
    const restoreAfterPointer = await adminContext.request.patch(
      "/api/admin/bed-allocation/allocations",
      {
        data: {
          allocationIds,
          bedId: originalBedId,
        },
      },
    );
    expect(
      restoreAfterPointer.ok(),
      `restore after pointer drop (${restoreAfterPointer.status()})`,
    ).toBeTruthy();
    await page.reload();
    await expect(dragHandle()).toBeVisible();

    async function moveKeyboardFocusToDestination() {
      const sourceBox = await dragHandle().boundingBox();
      const destinationBox = await targetCell().boundingBox();
      expect(sourceBox).toBeTruthy();
      expect(destinationBox).toBeTruthy();
      const direction =
        destinationBox!.y >= sourceBox!.y ? "ArrowDown" : "ArrowUp";
      const maxSteps =
        Math.ceil(
          Math.abs(
            destinationBox!.y +
              destinationBox!.height / 2 -
              (sourceBox!.y + sourceBox!.height / 2),
          ) / 25,
        ) + 4;
      for (let step = 0; step < maxSteps; step += 1) {
        await page.keyboard.press(direction);
        if (await preview().isVisible().catch(() => false)) return;
      }
      throw new Error(
        `Keyboard sensor did not reach ${destination!.roomName} / ${destination!.name}`,
      );
    }

    // Keyboard preview + cancel: pickup and navigation are real key events.
    await dragHandle().focus();
    await page.keyboard.press("Space");
    await moveKeyboardFocusToDestination();
    await expect(preview()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect.poll(() => moveRequests.length).toBe(1);
    persisted = await readPersisted();
    expect(
      persisted.every((allocation) => allocation.bedId === originalBedId),
    ).toBe(true);

    // Keyboard drop: the live preview is followed by a real Space drop and a
    // second date-free PATCH. The persisted nights remain byte-for-byte equal.
    await dragHandle().focus();
    await page.keyboard.press("Space");
    await moveKeyboardFocusToDestination();
    await page.keyboard.press("Space");
    await expect(page.getByText("Visible guest nights moved")).toBeVisible({
      timeout: 30_000,
    });
    expect(moveRequests).toHaveLength(2);
    expect(moveRequests[1]).toEqual({
      allocationIds,
      bedId: destination!.id,
    });
    expect(moveRequests[1]).not.toHaveProperty("stayDate");
    persisted = await readPersisted();
    expect(persisted.map((allocation) => allocation.stayDate)).toEqual(
      originalDates,
    );
    expect(
      persisted.every((allocation) => allocation.bedId === destination!.id),
    ).toBe(true);

  } catch (error) {
    scenarioError = error;
    throw error;
  } finally {
    const cleanupErrors: unknown[] = [];
    try {
      const restored = await adminContext.request.patch(
        "/api/admin/bed-allocation/allocations",
        {
          data: {
            allocationIds,
            bedId: originalBedId,
          },
        },
      );
      if (!restored.ok()) {
        cleanupErrors.push(
          new Error(
            `restore seeded bed (${restored.status()}): ${await restored.text()}`,
          ),
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await page.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      if (scenarioError) {
        await testInfo
          .attach("bed-allocation-cleanup-errors", {
            body: cleanupErrors
              .map((error) =>
                error instanceof Error
                  ? (error.stack ?? error.message)
                  : String(error),
              )
              .join("\n\n"),
            contentType: "text/plain",
          })
          .catch(() => undefined);
      } else {
        throw new AggregateError(
          cleanupErrors,
          "Bed-allocation E2E fixture cleanup failed",
        );
      }
    }
  }
});

// High row (docs/END_TO_END_TEST_MATRIX.md): "Allocate and confirm beds from
// inside a booking" (#2252). Runs after the board test above, on the same
// serial fixture: Ken's guest is already on A1 and approved. A single-night
// move re-DRAFTS that row — one of the three ways drafts keep arising under
// #2251's auto-approve — and the in-booking Bed allocation panel then confirms
// it, which is the whole point of the booking-scoped approve selector.
test("an admin confirms this booking's beds from the booking page, and the member never sees the panel", async ({
  browser,
}) => {
  const ken = DEMO_BOOKING_WINDOWS.kenReview;

  // Resolve Ken's booking and a second bed from the board's own read, rather
  // than hard-coding ids the seed is free to change.
  const dashboard = await adminContext.request.get(
    `/api/admin/bed-allocation?from=${ken.checkIn}&to=${ken.checkOut}`,
  );
  expect(dashboard.ok(), `read the board (${dashboard.status()})`).toBeTruthy();
  const payload = (await dashboard.json()) as {
    rooms: Array<{ active: boolean; beds: Array<{ id: string; active: boolean }> }>;
    allocations: Array<{
      bookingId: string;
      bookingGuestId: string;
      bedId: string;
      stayDate: string;
      guestName: string;
    }>;
  };
  const kensAllocation = payload.allocations.find((allocation) =>
    allocation.guestName.includes("Ken"),
  );
  expect(kensAllocation, "Ken is on a bed after the board test").toBeTruthy();

  const otherBed = payload.rooms
    .filter((room) => room.active)
    .flatMap((room) => room.beds)
    .find((bed) => bed.active && bed.id !== kensAllocation!.bedId);
  expect(otherBed, "a second active bed exists to move onto").toBeTruthy();

  // Moving an approved row clears its approval — the lock is not one-way.
  const moved = await adminContext.request.post(
    "/api/admin/bed-allocation/allocations",
    {
      data: {
        bookingGuestId: kensAllocation!.bookingGuestId,
        bedId: otherBed!.id,
        stayDate: kensAllocation!.stayDate,
      },
    },
  );
  expect(moved.ok(), `move Ken to a second bed (${moved.status()})`).toBeTruthy();

  // ── Confirm from inside the booking ──
  const page = await adminContext.newPage();
  await page.goto(`/bookings/${kensAllocation!.bookingId}`);

  const panel = page.locator("#bed-allocation");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText("Ken", { exact: false }).first()).toBeVisible();
  await expect(
    panel.getByRole("link", { name: "Open on the board" }),
  ).toBeVisible();

  const confirmButton = panel.getByRole("button", {
    name: "Confirm draft beds",
  });
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
  await expect(page.getByText(/Confirmed \d+ bed night/)).toBeVisible();
  // The panel refetches after the write: with nothing left in draft, Confirm
  // disables itself rather than offering a no-op.
  await expect(confirmButton).toBeDisabled({ timeout: 30_000 });
  await page.close();

  // ── The member never gets the panel ──
  // personas.booker is the only member persona with saved storage state, so it
  // is the only one that can actually sign in here.
  const memberContext = await browser.newContext({
    storageState: storageStatePath(personas.booker.email),
  });
  try {
    const memberPage = await memberContext.newPage();
    await memberPage.goto("/bookings");
    // The whole booking card is one anchor (my-bookings-list.tsx), so target
    // the href rather than a label.
    const firstBooking = memberPage
      .locator('a[href^="/bookings/"]')
      .first();
    await expect(firstBooking).toBeVisible({ timeout: 30_000 });
    await firstBooking.click();
    await expect(memberPage).toHaveURL(/\/bookings\/[^/?]+/);
    await expect(memberPage.locator("#bed-allocation")).toHaveCount(0);
    await expect(
      memberPage.getByRole("heading", { name: "Bed allocation" }),
    ).toHaveCount(0);
    // …and not even the section-rail link (#2252 review). The rail used to be
    // built from every candidate anchor and pruned in an effect after mount, so
    // the member's server-rendered HTML really did carry a "Bed Allocation"
    // link for a moment. It is now filtered out server-side, so it is absent
    // from the very first paint — asserted on the rail's own <nav>, which is
    // where a pruned-after-hydration entry would still have flashed.
    await expect(
      memberPage
        .getByRole("navigation", { name: "On this page" })
        .getByRole("link", { name: "Bed Allocation" }),
    ).toHaveCount(0);
    await memberPage.close();
  } finally {
    await memberContext.close();
  }
});
