import { type BrowserContext, expect, test, type Page } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import {
  overrideSingleLodgeAutoAllocation,
  setBedAllocationSettings,
  type BedAllocationSettingsSnapshot,
} from "./helpers/bed-allocation-settings";
import {
  bookingCreateIsolation,
  postBookingCreate,
  withBookingCreateClientIp,
} from "./helpers/booking-create-client-ip";
import { personas } from "./helpers/personas";
import {
  DEMO_BOOKING_WINDOWS,
  E2E_ADMIN,
  WAITLIST_FULL_WINDOW,
} from "./helpers/fixtures";
import { calendarMonthDirection } from "./helpers/calendar-navigation";
import {
  calendarDayLabel,
  pastStayWindowForAttempt,
} from "./helpers/stay-dates";

// docs/END_TO_END_TEST_MATRIX.md row "Admin retroactive create (#1695)": a Full
// Admin records a stay that already happened via /admin/book — toggle "Record a
// past stay", pick past dates inside the seeded Winter season, and confirm with
// an explicit member-email choice. The over-capacity confirm and Xero lock-date
// guard paths are covered at route/service level (Xero is not connected in E2E,
// so the lock guard is a no-op here by design). Negatives: a member's own /book
// calendar keeps past days disabled, and a member POST carrying allowPastDates
// is rejected 403.
//
// Past dates are chosen relative to the run clock and must land inside the
// seeded (relative) Winter season — the same season-coverage constraint every
// date-based spec carries (issue #2117: seasons and seeded bookings are now
// relative, so attempts 0/1/2 at -7/-11/-15 days are always in-season and
// clear of the seeded windows on any run date).
test.describe.configure({ mode: "serial" });

let memberContext: BrowserContext;
let adminContext: BrowserContext;
let bedAllocationSettingsBefore: BedAllocationSettingsSnapshot | undefined;

function isoDay(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Seeded windows the sliding past window must dodge (prisma/e2e-fixtures.ts,
// now RELATIVE — issue #2117). The retroactive create would otherwise fail:
// - Alice's own DRAFT booking counts for the member-night conflict check
//   (aliceDraft sits deep in the past, well clear of the -7..-15 sweep, but is
//   listed so the dodge stays honest if its offset ever changes).
// - The waitlist fixture window is seeded full to lodge capacity, which would
//   trigger the over-capacity confirm dialog this happy-path spec does not
//   drive (it is a future Monday, so it never overlaps a past window anyway).
const SEEDED_BLOCKED_RANGES: ReadonlyArray<readonly [string, string]> = [
  [DEMO_BOOKING_WINDOWS.aliceDraft.checkIn, DEMO_BOOKING_WINDOWS.aliceDraft.checkOut],
  [WAITLIST_FULL_WINDOW.checkIn, WAITLIST_FULL_WINDOW.checkOut],
];

// Navigate from the month the calendar currently displays to the month holding
// dateOnly, then click the day. A retroactive stay can cross a month boundary:
// after its past check-in is selected, its check-out can be in the NEXT month.
async function selectPastCalendarDay(
  page: Page,
  dateOnly: string,
  displayedDateOnly: string,
): Promise<void> {
  const [y, m] = dateOnly.split("-").map(Number);
  const monthHeading = new Date(y, m - 1).toLocaleDateString("en-NZ", {
    month: "long",
    year: "numeric",
  });
  const direction = calendarMonthDirection(displayedDateOnly, dateOnly);
  const navigationButton = direction === "previous" ? /Prev/ : /Next/;
  const heading = page.getByRole("heading", { name: monthHeading });
  for (let hops = 0; hops < 14; hops += 1) {
    if (await heading.isVisible().catch(() => false)) {
      break;
    }
    await page.getByRole("button", { name: navigationButton }).click();
  }
  await expect(
    heading,
    `calendar never reached ${monthHeading} while moving ${direction} from ` +
      `${displayedDateOnly} to ${dateOnly}`,
  ).toBeVisible();
  await page.getByRole("button", { name: calendarDayLabel(dateOnly) }).click();
}

// The member details confirmation gate can appear on the first /book visit.
async function dismissDetailsGateIfShown(page: Page): Promise<void> {
  const dialogTitle = page.getByText("Confirm member details");
  try {
    await dialogTitle.waitFor({ state: "visible", timeout: 5_000 });
  } catch {
    return;
  }
  const dialog = page.getByRole("dialog");
  const confirmCorrect = dialog.getByRole("button", {
    name: "Confirm details are correct",
  });
  if (await confirmCorrect.isVisible().catch(() => false)) {
    await confirmCorrect.click();
  }
  const finish = dialog.getByRole("button", { name: "Confirm and finish" });
  if (await finish.isVisible().catch(() => false)) {
    await finish.click();
  }
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000);

  memberContext = await browser.newContext({
    storageState: storageStatePath(personas.booker.email),
  });

  // Reuse the E2E admin session saved once in auth.setup.ts instead of a fresh
  // per-spec login (#1779).
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });

  // A retroactive (cross-month) create can trigger the reconcile sweep to
  // auto-place bookings lodge-wide; disable auto-allocation for this spec so it
  // never disturbs the bed-allocation spec's fixtures (which owns the same
  // setting for its own run).
  bedAllocationSettingsBefore = await overrideSingleLodgeAutoAllocation(
    adminContext.request,
    false,
  );
});

test.afterAll(async () => {
  try {
    if (adminContext) {
      if (bedAllocationSettingsBefore) {
        await setBedAllocationSettings(
          adminContext.request,
          bedAllocationSettingsBefore,
        );
      }
    }
  } finally {
    await memberContext?.close();
    await adminContext?.close();
  }
});

test("an admin records a past stay on behalf of a member without emailing them", async ({}, testInfo) => {
  const { checkIn: pastCheckIn, checkOut: pastCheckOut } =
    pastStayWindowForAttempt(testInfo.retry, SEEDED_BLOCKED_RANGES);
  const page = await adminContext.newPage();
  await page.goto("/admin/book");
  await expect(
    page.getByRole("heading", { name: "Book on Behalf of Member" }),
  ).toBeVisible();

  // Pick the target member through the search picker.
  // #2264: the picker's visible label is now associated with its input, so
  // select by accessible name instead of by placeholder.
  await page
    .getByRole("textbox", { name: "Search for a member to book on behalf of" })
    .fill(personas.booker.firstName);
  await page
    .getByRole("button", {
      name: new RegExp(
        `${personas.booker.firstName} ${personas.booker.lastName}`,
      ),
    })
    .first()
    .click();

  await expect(page.getByText("Select Dates", { exact: true })).toBeVisible();

  // Opt into retroactive booking, then pick past dates inside the seeded season.
  await page.getByRole("checkbox", { name: /Record a past stay/ }).check();
  await selectPastCalendarDay(page, pastCheckIn, isoDay(0));
  await selectPastCalendarDay(page, pastCheckOut, pastCheckIn);

  // Quick-add the member themselves as the guest.
  await page
    .getByRole("button", {
      name: `+ ${personas.booker.firstName} ${personas.booker.lastName}`,
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();

  await expect(page.getByText("Booking Summary")).toBeVisible();
  // The review step flags the retroactive context.
  await expect(page.getByText(/Recording a past stay/)).toBeVisible();

  // Confirm opens the per-create email-choice dialog; take "without emailing".
  await page.getByRole("button", { name: "Confirm Booking" }).click();
  const withoutEmail = page.getByRole("button", {
    name: "Create without emailing",
  });
  await expect(withoutEmail).toBeVisible();

  // The persisted booking renders its past check-in date. Match the full
  // formatted date ("Friday, 3 July 2026") — a bare day-number regex collides
  // with timestamps elsewhere on the page (strict-mode violation).
  const [y, m, d] = pastCheckIn.split("-").map(Number);
  const checkInText = new Date(y, m - 1, d).toLocaleDateString("en-NZ", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // Wait for the POST itself — the Confirm button flips to "Creating booking..."
  // the instant the dialog choice fires, so a button-state wait would race the
  // in-flight request and the caller's navigation could abort it.
  await withBookingCreateClientIp(
    page,
    bookingCreateIsolation("admin-retroactive-record", testInfo.retry),
    {
      trigger: () =>
        Promise.all([
          page.waitForResponse(
            (r) =>
              r.url().endsWith("/api/bookings") &&
              r.request().method() === "POST",
            { timeout: 30_000 },
          ),
          withoutEmail.click(),
        ]),
      // The create navigates, so the interception is held until the new
      // booking's own detail page is really rendered.
      waitForOutcome: async ([response]) => {
        expect(
          response.status(),
          `retroactive create (${response.status()})`,
        ).toBe(201);
        await expect(page).toHaveURL(/\/bookings\/[A-Za-z0-9-]+$/);
        await expect(page.getByText(checkInText).first()).toBeVisible();
      },
    },
  );
  await page.close();
});

test("a member's own /book calendar keeps past days disabled", async () => {
  const page = await memberContext.newPage();
  await page.goto("/book");
  await dismissDetailsGateIfShown(page);
  await expect(page.getByText("Select Your Dates")).toBeVisible();

  // Step back one month; every day there is in the past and must be disabled for
  // a member (no retroactive flag on the member calendar).
  const lastMonth = isoDay(-32);
  const [y, m] = lastMonth.split("-").map(Number);
  const monthHeading = new Date(y, m - 1).toLocaleDateString("en-NZ", {
    month: "long",
    year: "numeric",
  });
  for (let hops = 0; hops < 3; hops += 1) {
    if (
      await page
        .getByRole("heading", { name: monthHeading })
        .isVisible()
        .catch(() => false)
    ) {
      break;
    }
    await page.getByRole("button", { name: /Prev/ }).click();
  }
  const pastDay = page.getByRole("button", { name: calendarDayLabel(lastMonth) });
  await expect(pastDay).toBeDisabled();
  await page.close();
});

test("a member POST carrying allowPastDates is rejected 403", async ({}, testInfo) => {
  const res = await postBookingCreate(
    memberContext.request,
    bookingCreateIsolation(
      "admin-retroactive-member-rejection",
      testInfo.retry,
    ),
    {
      data: {
        checkIn: isoDay(30),
        checkOut: isoDay(32),
        guests: [
          {
            firstName: "Alice",
            lastName: "Anderson",
            ageTier: "ADULT",
            isMember: true,
          },
        ],
        allowPastDates: true,
      },
    },
  );
  expect(res.status(), `member allowPastDates (${res.status()})`).toBe(403);
});
