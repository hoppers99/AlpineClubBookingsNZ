import { type BrowserContext, expect, test } from "@playwright/test";
import { loginPersona, storageStatePath } from "./helpers/auth";
import { personas } from "./helpers/personas";
import {
  E2E_ADMIN,
  LODGE_FILL_OWNER,
  WAITLIST_FULL_WINDOW,
  WAITLISTER,
} from "./helpers/fixtures";
import { stayWindow } from "./helpers/stay-dates";

/*
  #2263 (epic #2245) — the member whole-lodge request journey, and the privacy
  guarantee it is built around.

  Matrix rows (docs/END_TO_END_TEST_MATRIX.md):
    - Critical: member whole-lodge journey (submit → officer approves → hold).
    - Critical: uniform-response privacy (the byte-compare below).
    - High:     admin queue badges, availability strip, approve + hold.

  WHY THE BYTE-COMPARE LIVES HERE AND NOT IN VITEST. The unit layer runs with
  Prisma mocked, so "three worlds" there is a fiction: the same mock answers
  every question identically whatever the world is supposed to be, and the test
  passes without ever having had three worlds. The claim is only worth something
  against REAL ROWS, which means the seeded database and therefore Playwright.

  The three worlds:
    A. CLEAR      — a fresh stay window nothing else touches.
    B. FULL        — WAITLIST_FULL_WINDOW, seeded to the lodge's capacity.
    C. HELD        — a window this spec puts an exclusive whole-lodge hold on,
                     via the admin exclusive-hold route, before submitting.

  MECHANICS THAT MATTER:
    - THREE DISTINCT MEMBER SESSIONS, one per world. The cap of two open
      requests per member and the shared per-member rate-limit window would
      otherwise make the result depend on submission order — the third
      submission from one member would 409 on the cap and the test would be
      asserting the wrong thing (or, worse, pass by comparing two identical
      error bodies).
    - The per-IP limiter (5/hr) IS shared across all three. Three submissions
      fit; no other whole-lodge submission may run in this file's window, which
      is why the journey test at the end reuses one of the three requests rather
      than sending a fourth.
*/

test.describe.configure({ mode: "serial" });

// Indices 0–9 are taken by the other specs; these two are this file's alone, so
// the "clear" world really is clear and the "held" world is held by nothing but
// the hold this spec places.
const CLEAR_WINDOW = stayWindow(11);
const HELD_WINDOW = stayWindow(12);

const REQUEST_BODY = {
  headcount: 6,
  groupDescription: "Club alpine skills course",
};

let adminContext: BrowserContext;
let aliceContext: BrowserContext;
let wandaContext: BrowserContext;
// A THIRD distinct member, not Bob/Evan: those two are deliberately seeded
// un-enrolled in two-factor so the 2FA specs can drive real enrollment, and
// logging them in here would consume that state.
let thirdMemberContext: BrowserContext;

test.beforeAll(async ({ browser }) => {
  // Up to two fresh logins, each possibly including first-time two-factor
  // enrollment: more than the default 90s hook budget on a loaded runner.
  test.setTimeout(300_000);

  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });

  aliceContext = await browser.newContext();
  const alicePage = await aliceContext.newPage();
  await loginPersona(alicePage, personas.booker.email);
  await alicePage.close();

  wandaContext = await browser.newContext();
  const wandaPage = await wandaContext.newPage();
  await loginPersona(wandaPage, WAITLISTER.email);
  await wandaPage.close();

  thirdMemberContext = await browser.newContext();
  const thirdPage = await thirdMemberContext.newPage();
  await loginPersona(thirdPage, LODGE_FILL_OWNER.email);
  await thirdPage.close();
});

test.afterAll(async () => {
  await adminContext?.close();
  await aliceContext?.close();
  await wandaContext?.close();
  await thirdMemberContext?.close();
});

/** Submit one whole-lodge request and return the raw status + body BYTES. */
async function submitWholeLodgeRequest(
  context: BrowserContext,
  window: { checkIn: string; checkOut: string },
) {
  const response = await context.request.post(
    "/api/booking-requests/whole-lodge",
    {
      data: {
        ...REQUEST_BODY,
        checkIn: window.checkIn,
        checkOut: window.checkOut,
      },
    },
  );
  return {
    status: response.status(),
    bytes: Buffer.from(await response.body()),
  };
}

test("the acknowledgement is byte-identical whether the lodge is clear, full, or exclusively held", async () => {
  test.setTimeout(180_000);

  // --- World C setup: make HELD_WINDOW exclusively held ---------------------
  // A member books the window as an ordinary stay, then an admin sets the
  // exclusive whole-lodge hold on it. From that moment every OTHER member sees
  // those nights as simply unavailable — the same word a genuinely full lodge
  // gets, which is the rule this whole test exists to prove is not observable.
  //
  // The booking is created from a MEMBER session with no payment method (the
  // same shape e2e/waitlist.spec.ts uses): the admin on-behalf route's
  // internet-banking branch is not enabled on the staging stack, and this world
  // only needs a capacity-holding booking to hang the hold on.
  const holdBookingResponse = await wandaContext.request.post("/api/bookings", {
    data: {
      checkIn: HELD_WINDOW.checkIn,
      checkOut: HELD_WINDOW.checkOut,
      guests: [
        {
          firstName: WAITLISTER.firstName,
          lastName: WAITLISTER.lastName,
          ageTier: "ADULT",
          isMember: true,
        },
      ],
    },
  });
  expect(
    holdBookingResponse.status(),
    `could not create the booking to hold: ${await holdBookingResponse.text()}`,
  ).toBe(201);
  const holdBooking = (await holdBookingResponse.json()) as {
    booking?: { id?: string };
    id?: string;
  };
  const holdBookingId = holdBooking.booking?.id ?? holdBooking.id;
  expect(holdBookingId).toBeTruthy();

  const setHold = await adminContext.request.post(
    `/api/admin/bookings/${holdBookingId}/exclusive-hold`,
    { data: { hold: true } },
  );
  expect(setHold.ok(), await setHold.text()).toBe(true);

  // --- The three submissions, one member each -------------------------------
  const clear = await submitWholeLodgeRequest(aliceContext, CLEAR_WINDOW);
  const full = await submitWholeLodgeRequest(wandaContext, WAITLIST_FULL_WINDOW);
  const held = await submitWholeLodgeRequest(thirdMemberContext, HELD_WINDOW);

  // All three must have SUCCEEDED. A 429 or 409 here would make the byte
  // comparison vacuous — three identical error bodies also compare equal.
  expect(clear.status, "clear-window submission did not succeed").toBe(201);
  expect(full.status, "full-window submission did not succeed").toBe(201);
  expect(held.status, "held-window submission did not succeed").toBe(201);

  // Buffer equality, not deep-equal on parsed JSON: two objects can be
  // deep-equal and still serialise to different bytes (key order, spacing), and
  // it is the BYTES on the wire that a member can measure.
  expect(
    full.bytes.equals(clear.bytes),
    "a full lodge produced a different acknowledgement from a clear one",
  ).toBe(true);
  expect(
    held.bytes.equals(clear.bytes),
    "an exclusively-held lodge produced a different acknowledgement from a clear one",
  ).toBe(true);

  // And the body echoes nothing that was submitted — no dates, no headcount, no
  // reference. An echo is a channel.
  const body = clear.bytes.toString("utf8");
  expect(body).not.toContain(CLEAR_WINDOW.checkIn);
  expect(body).not.toContain(String(REQUEST_BODY.headcount));
  expect(body).not.toContain("alpine skills");
});

test("the member sees no availability, price or capacity hint on the request form", async () => {
  const page = await aliceContext.newPage();
  await page.goto("/book");

  // The entry point sits beside the wizard, which is untouched.
  await expect(
    page.getByRole("link", { name: /book the whole lodge/i }),
  ).toBeVisible();

  await page.goto("/book/whole-lodge");
  await expect(
    page.getByRole("heading", { name: /book the whole lodge/i }),
  ).toBeVisible();

  // The form asks for a headcount and who the group is, and NOTHING that would
  // answer "is the lodge free that week?".
  await expect(page.getByLabel(/roughly how many people/i)).toBeVisible();
  await expect(page.getByLabel(/who is the group/i)).toBeVisible();

  const content = (await page.textContent("body")) ?? "";
  expect(content).not.toMatch(/beds? (left|available|free)/i);
  expect(content).not.toMatch(/fully booked|at capacity|no beds/i);
  expect(content).not.toMatch(/exclusiv/i);
  // No price is quoted at request time.
  expect(content).not.toMatch(/\$\d/);

  await page.close();
});

test("the officer sees the member badges and the admin-only availability strip, and approving holds the lodge", async () => {
  test.setTimeout(180_000);

  const page = await adminContext.newPage();
  await page.goto("/admin/booking-requests");

  // Both badges: "Member" (this came from an account) and "Whole lodge
  // requested" (the exclusivity ask, which the queue never used to show).
  await expect(page.getByText("Whole lodge requested").first()).toBeVisible();
  await expect(page.getByText("Member", { exact: true }).first()).toBeVisible();

  // The availability strip is admin-only and collapsed by default.
  const strip = page
    .getByRole("button", { name: /show availability for these nights/i })
    .first();
  await expect(strip).toBeVisible();
  await strip.click();
  await expect(
    page.getByText(/beds|held/i).first(),
  ).toBeVisible();

  // Approve the CLEAR-window request. Its own admission must fit, which is why
  // the clear window is the one approved.
  const requests = (await (
    await adminContext.request.get(
      "/api/admin/booking-requests?status=VERIFIED&pageSize=100",
    )
  ).json()) as {
    data: Array<{
      id: string;
      checkIn: string;
      requestedByMemberId: string | null;
      exclusivityRequested: boolean;
    }>;
  };
  const target = requests.data.find(
    (row) =>
      row.requestedByMemberId &&
      row.exclusivityRequested &&
      row.checkIn.startsWith(CLEAR_WINDOW.checkIn),
  );
  expect(target, "the clear-window member request was not in the queue").toBeTruthy();

  const approve = await adminContext.request.post(
    `/api/admin/booking-requests/${target!.id}/approve`,
    { data: { pricedHeadcount: REQUEST_BODY.headcount } },
  );
  expect(approve.ok(), await approve.text()).toBe(true);
  const approved = (await approve.json()) as {
    type: string;
    bookingId: string;
    priceCents: number;
    exclusiveHoldConflicts: unknown[];
  };
  expect(approved.type).toBe("MEMBER_WHOLE_LODGE");
  expect(approved.priceCents).toBeGreaterThan(0);
  // Conflict surfacing reaches the ADMIN caller (empty here — the window was
  // clear — but the field is part of the admin contract).
  expect(Array.isArray(approved.exclusiveHoldConflicts)).toBe(true);

  // Re-approving replays idempotently onto the SAME booking: no second booking,
  // no second charge.
  const replay = await adminContext.request.post(
    `/api/admin/booking-requests/${target!.id}/approve`,
    { data: { pricedHeadcount: REQUEST_BODY.headcount } },
  );
  expect(replay.ok(), await replay.text()).toBe(true);
  expect(((await replay.json()) as { bookingId: string }).bookingId).toBe(
    approved.bookingId,
  );

  await page.close();
});

test("the approved booking shows as a plain unavailable lodge to everyone else, and as Approved to its owner", async () => {
  // Another member's availability view says only that the nights are
  // unavailable — never that they are exclusively held, and never who has them.
  const availability = await wandaContext.request.get(
    `/api/bookings/availability?month=${CLEAR_WINDOW.checkIn.slice(0, 7)}`,
  );
  if (availability.ok()) {
    const text = await availability.text();
    expect(text.toLowerCase()).not.toContain("exclusiv");
    expect(text.toLowerCase()).not.toContain("wholelodge");
    expect(text.toLowerCase()).not.toContain("whole_lodge");
  }

  // The owner sees it under My requests, approved, with a link to the booking.
  const page = await aliceContext.newPage();
  await page.goto("/bookings");
  await expect(
    page.getByRole("heading", { name: /my requests/i }),
  ).toBeVisible();
  await expect(page.getByText(/^approved$/i).first()).toBeVisible();
  await expect(
    page.getByRole("link", { name: /open booking/i }).first(),
  ).toBeVisible();
  // The bounded-history statement is part of the contract with the member, not
  // decoration: declined and withdrawn rows really are purged at 90 days.
  await expect(page.getByText(/removed after 90 days/i)).toBeVisible();
  await page.close();
});

test("a member can withdraw a pending request, and the section disappears when nothing is left", async () => {
  // Wanda's full-window request is still pending, so it is withdrawable.
  const page = await wandaContext.newPage();
  await page.goto("/bookings");

  const withdraw = page.getByRole("button", { name: /^withdraw$/i }).first();
  await expect(withdraw).toBeVisible();
  await withdraw.click();

  await expect(page.getByText(/^withdrawn$/i).first()).toBeVisible();
  // Withdraw is not offered twice.
  await expect(page.getByRole("button", { name: /^withdraw$/i })).toHaveCount(0);

  await page.close();
});

test("a member cannot withdraw somebody else's request", async () => {
  const wandaRequests = (await (
    await adminContext.request.get(
      "/api/admin/booking-requests?status=ALL&pageSize=100",
    )
  ).json()) as {
    data: Array<{ id: string; requestedByMemberId: string | null }>;
  };
  const someoneElses = wandaRequests.data.find(
    (row) => row.requestedByMemberId,
  );
  expect(someoneElses).toBeTruthy();

  // This context is signed in as a different member. The WHERE names the owner, so an
  // id belonging to somebody else behaves exactly like one that does not exist.
  const response = await thirdMemberContext.request.post(
    `/api/booking-requests/whole-lodge/${someoneElses!.id}/withdraw`,
  );
  expect([404, 409]).toContain(response.status());
});

test("an anonymous caller cannot submit a whole-lodge request at all", async ({
  request,
}) => {
  const response = await request.post("/api/booking-requests/whole-lodge", {
    data: {
      ...REQUEST_BODY,
      checkIn: CLEAR_WINDOW.checkIn,
      checkOut: CLEAR_WINDOW.checkOut,
    },
  });
  // The public GENERAL front-door still may not ask for the whole lodge; this
  // door requires a session (ADR-001, dated 2026-07-30 entry).
  expect(response.status()).toBe(401);
});
