import { expect, test, type Page } from "@playwright/test";
import { storageStatePath } from "./helpers/auth";
import { DEMO_BOOKING_WINDOWS, E2E_ADMIN } from "./helpers/fixtures";

/**
 * #2622 — a guest who leaves this morning is on this morning's chore roster.
 *
 * Two seeded days carry the whole change end to end:
 *   - `rosterEdit.checkOut` is a MIXED TURNOVER day: five guests leave that
 *     morning while two arrive that evening.
 *   - `rosterTurnover.checkOut` is an ALL-DEPARTING day: its only occupants
 *     are on their way home, and before this issue the roster saw nobody there
 *     at all.
 *
 * Both must generate, edit, save and confirm like any other lodge day.
 */
test.use({ storageState: storageStatePath(E2E_ADMIN.email) });

const TURNOVER_DAY = DEMO_BOOKING_WINDOWS.rosterEdit.checkOut;
const ALL_DEPARTING_DAY = DEMO_BOOKING_WINDOWS.rosterTurnover.checkOut;

type BrowserRoster = {
  guests: Array<{
    id: string;
    bookingId: string;
    firstName: string;
    lastName: string;
    bookingGroupLabel: string;
    isArriving?: boolean;
    isDeparting?: boolean;
  }>;
  assignments: Array<{
    id: string;
    bookingGuestId: string | null;
    choreTemplateId: string;
    status: string;
  }>;
  revision: string;
};

function rosterGet(page: Page, date: string) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/api/admin/roster/${date}` &&
      url.searchParams.has("lodgeId") &&
      response.request().method() === "GET";
  });
}

function rosterAction(page: Page, date: string, action: string) {
  return page.waitForResponse((response) =>
    new URL(response.url()).pathname === `/api/admin/roster/${date}` &&
    response.request().method() === "PUT" &&
    response.request().postDataJSON()?.action === action,
  );
}

async function loadRosterDate(page: Page, date: string): Promise<BrowserRoster> {
  const initialLoad = rosterGet(page, DEMO_BOOKING_WINDOWS.rosterEdit.checkIn);
  await page.goto("/admin/roster");
  // The page opens on today; wait for its own load to settle before switching.
  await Promise.race([initialLoad, page.waitForTimeout(5_000)]);

  const loaded = rosterGet(page, date);
  await page.locator("#date").fill(date);
  const response = await loaded;
  expect(response.ok()).toBe(true);
  await expect(page.locator("#date")).toHaveValue(date);
  return response.json() as Promise<BrowserRoster>;
}

async function regenerate(page: Page, date: string): Promise<BrowserRoster> {
  const action = rosterAction(page, date, "regenerate");
  const reload = rosterGet(page, date);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Regenerate Roster" }).click();
  expect((await action).ok()).toBe(true);
  const response = await reload;
  expect(response.ok()).toBe(true);
  return response.json() as Promise<BrowserRoster>;
}

async function saveUnchanged(page: Page, date: string) {
  const saved = rosterAction(page, date, "save");
  await page.getByRole("button", { name: "Edit roster" }).click();
  await page.getByRole("button", { name: "Save roster" }).click();
  const response = await saved;
  expect(response.status(), await response.text()).toBe(200);
}

async function confirm(page: Page, date: string) {
  const confirmed = rosterAction(page, date, "confirm");
  const reload = rosterGet(page, date);
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Confirm Roster" }).click();
  expect((await confirmed).ok()).toBe(true);
  const response = await reload;
  expect(response.ok()).toBe(true);
  return response.json() as Promise<BrowserRoster>;
}

test("rosters an all-departing day and confirms it", async ({ page }) => {
  const initial = await loadRosterDate(page, ALL_DEPARTING_DAY);

  // Everyone here is leaving this morning. Before #2622 this list was empty
  // and the roster for the shutdown had nobody on it.
  expect(initial.guests.length).toBeGreaterThan(0);
  expect(initial.guests.every((guest) => guest.isDeparting === true)).toBe(true);
  expect(initial.guests.every((guest) => guest.isArriving !== true)).toBe(true);
  expect(new Set(initial.guests.map((guest) => guest.id)).size).toBe(
    initial.guests.length,
  );

  const departingIds = new Set(initial.guests.map((guest) => guest.id));
  await expect(page.getByText("Departing").first()).toBeVisible();

  const regenerated = await regenerate(page, ALL_DEPARTING_DAY);
  expect(regenerated.assignments.length).toBeGreaterThan(0);
  for (const assignment of regenerated.assignments) {
    expect(departingIds.has(assignment.bookingGuestId ?? "")).toBe(true);
  }

  await saveUnchanged(page, ALL_DEPARTING_DAY);
  const confirmed = await confirm(page, ALL_DEPARTING_DAY);
  expect(confirmed.assignments.length).toBeGreaterThan(0);
  expect(
    confirmed.assignments.every((assignment) => assignment.status === "CONFIRMED"),
  ).toBe(true);
});

test("rosters a mixed turnover day with both sides of midday", async ({ page }) => {
  const initial = await loadRosterDate(page, TURNOVER_DAY);

  const departing = initial.guests.filter((guest) => guest.isDeparting);
  const arriving = initial.guests.filter((guest) => guest.isArriving);
  expect(departing.length).toBeGreaterThan(0);
  expect(arriving.length).toBeGreaterThan(0);
  // Nobody is on both sides of midday, and nobody is listed twice.
  expect(departing.some((guest) => guest.isArriving)).toBe(false);
  expect(new Set(initial.guests.map((guest) => guest.id)).size).toBe(
    initial.guests.length,
  );
  // Both bookings are represented, so the roster covers the whole changeover.
  expect(new Set(initial.guests.map((guest) => guest.bookingId)).size).toBeGreaterThan(1);

  await expect(page.getByText("Departing").first()).toBeVisible();
  await expect(page.getByText("Arriving").first()).toBeVisible();

  const regenerated = await regenerate(page, TURNOVER_DAY);
  expect(regenerated.assignments.length).toBeGreaterThan(0);
  const rosteredIds = new Set(initial.guests.map((guest) => guest.id));
  for (const assignment of regenerated.assignments) {
    expect(rosteredIds.has(assignment.bookingGuestId ?? "")).toBe(true);
  }

  // A departing guest can be chosen manually for any chore on the day: the
  // dropdown offers them and Save accepts them.
  await page.getByRole("button", { name: "Edit roster" }).click();
  const firstSelect = page.getByRole("combobox").first();
  const departingLabel = `${departing[0].firstName} ${departing[0].lastName} (departing today)`;
  await expect(firstSelect.locator("option", { hasText: departingLabel })).toHaveCount(1);
  const saved = rosterAction(page, TURNOVER_DAY, "save");
  await firstSelect.selectOption(departing[0].id);
  await page.getByRole("button", { name: "Save roster" }).click();
  const savedResponse = await saved;
  expect(savedResponse.status(), await savedResponse.text()).toBe(200);
  const savedRoster = await savedResponse.json() as BrowserRoster;
  expect(
    savedRoster.assignments.some(
      (assignment) => assignment.bookingGuestId === departing[0].id,
    ),
  ).toBe(true);

  const confirmed = await confirm(page, TURNOVER_DAY);
  expect(
    confirmed.assignments.every((assignment) => assignment.status === "CONFIRMED"),
  ).toBe(true);
});
