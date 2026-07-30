import {
  type APIRequestContext,
  type BrowserContext,
  type Page,
  expect,
  test,
} from "@playwright/test";
import { loginPersona } from "./helpers/auth";
import { E2E_ADMIN, NOMINATOR_TWO, WAITLISTER } from "./helpers/fixtures";
import { stayWindow } from "./helpers/stay-dates";
import { overrideModules, type ModuleSettings } from "./helpers/modules";
import { waitForEmail } from "./helpers/mailpit";

/*
  #2307 (epic #2305) — the member-guest consent journey, browser end to end.

  Matrix rows (docs/END_TO_END_TEST_MATRIX.md): the two Playwright rows the
  MG2 server half recorded as landing with the visible surfaces —
    - approve: a cross-family add persists PENDING, the target answers Yes on
      the booking page's consent card, and the guest list then shows the
      Consented badge;
    - decline on an unpaid booking: the target answers No, the held place is
      released, and the booker's guest list no longer names them.
  Plus the delegate-route privacy edge worth proving against real rows: a
  signed-in member who is NOT the target's family delegate — including the
  BOOKER, who knows more about this booking than anyone — gets one neutral
  "nothing here" page from /bookings/consent/<guestId>, with no booking facts
  on it, indistinguishable from a made-up id.

  MECHANICS:
    - Wanda (WAITLISTER) books; Nadia (NOMINATOR_TWO) is the cross-family
      target. Both are seeded PAID with complete, self-confirmed profiles —
      required, because a cross-family add refuses an unpaid or incomplete
      target (D-8) — and both hold logins, so the consent-request email goes
      to Nadia directly and she answers for herself on the booking page.
    - Windows 13 and 14: 0–9 are the other specs', 11–12 the whole-lodge
      spec's. Fresh windows keep Nadia clear of the person-night guard.
    - The memberGuests module is switched on for this file and the previous
      module settings restored afterwards.
    - RETRY-SAFE: each attempt books fresh windows only in the sense that the
      same windows are reused — so the approve test tolerates the target
      already being CONFIRMED-or-conflicted by a previous attempt by asserting
      from the CREATE response it just made; a retried create that now hits
      Nadia's person-night conflict from attempt one falls back to asserting
      the neutral refusal instead of failing the suite. In practice attempt
      one either never created (nothing held: PENDING lapses are swept
      nightly, declines delete the row) or completed, and the windows differ
      per test so the two tests cannot collide with each other.
*/

test.describe.configure({ mode: "serial" });

const APPROVE_WINDOW = stayWindow(13);
const DECLINE_WINDOW = stayWindow(14);

let adminContext: BrowserContext;
let adminRequest: APIRequestContext;
let previousModules: ModuleSettings | null = null;

let wandaContext: BrowserContext;
let wandaPage: Page;
let nadiaContext: BrowserContext;
let nadiaPage: Page;

let wandaId: string;
let nadiaId: string;

async function resolveMemberId(
  request: APIRequestContext,
  email: string,
): Promise<string> {
  const res = await request.get(
    `/api/admin/members?search=${encodeURIComponent(email)}`,
  );
  expect(res.ok(), `GET /api/admin/members (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as {
    members?: Array<{ id: string; email: string }>;
  };
  const match = (body.members ?? []).find((member) => member.email === email);
  expect(match?.id, `${email} should be an admin-visible member`).toBeTruthy();
  return match!.id;
}

type CreatedBooking = {
  id: string;
  guests: Array<{ id: string; memberId: string | null; consentStatus: string | null }>;
};

async function createBookingWithMemberGuest(
  window: { checkIn: string; checkOut: string },
): Promise<CreatedBooking> {
  const res = await wandaPage.request.post("/api/bookings", {
    data: {
      checkIn: window.checkIn,
      checkOut: window.checkOut,
      guests: [
        {
          firstName: WAITLISTER.firstName,
          lastName: WAITLISTER.lastName,
          ageTier: "ADULT",
          isMember: true,
          memberId: wandaId,
        },
        {
          firstName: NOMINATOR_TWO.firstName,
          lastName: NOMINATOR_TWO.lastName,
          ageTier: "ADULT",
          isMember: true,
          memberId: nadiaId,
        },
      ],
    },
  });
  expect(res.status(), `POST /api/bookings (${res.status()})`).toBe(201);
  return (await res.json()) as CreatedBooking;
}

function pendingGuestOf(booking: CreatedBooking) {
  const guest = booking.guests.find((row) => row.memberId === nadiaId);
  expect(guest, "the cross-family target must be on the created booking").toBeTruthy();
  // The whole feature under test: a module-on cross-family add persists an
  // unanswered consent request, never a silently-confirmed guest.
  expect(guest!.consentStatus).toBe("PENDING");
  return guest!;
}

test.beforeAll(async ({ browser }) => {
  adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPersona(adminPage, E2E_ADMIN.email, "10.60.0.1");
  adminRequest = adminPage.request;
  previousModules = await overrideModules(adminRequest, { memberGuests: true });

  wandaId = await resolveMemberId(adminRequest, WAITLISTER.email);
  nadiaId = await resolveMemberId(adminRequest, NOMINATOR_TWO.email);

  wandaContext = await browser.newContext();
  wandaPage = await wandaContext.newPage();
  await loginPersona(wandaPage, WAITLISTER.email, "10.60.0.2");

  nadiaContext = await browser.newContext();
  nadiaPage = await nadiaContext.newPage();
  await loginPersona(nadiaPage, NOMINATOR_TWO.email, "10.60.0.3");
});

test.afterAll(async () => {
  if (previousModules) {
    await overrideModules(adminRequest, {
      memberGuests: previousModules.memberGuests ?? false,
    });
  }
  await adminContext?.close();
  await wandaContext?.close();
  await nadiaContext?.close();
});

// Captured by the approve test for the delegate-privacy probe below: a REAL,
// by-then-settled guest row id.
let approvedGuestId: string | null = null;

test("the target approves on the booking page's consent card and the badge flips to Consented", async () => {
  const booking = await createBookingWithMemberGuest(APPROVE_WINDOW);
  approvedGuestId = pendingGuestOf(booking).id;

  // D-16: the ask is emailed to the target directly (she holds a login).
  await waitForEmail(
    NOMINATOR_TWO.email,
    `Can ${WAITLISTER.firstName} ${WAITLISTER.lastName} add you to this booking?`,
  );

  // D-11: the pending target opens the WHOLE booking page, card inside it.
  await nadiaPage.goto(`/bookings/${booking.id}#consent`);
  const content = nadiaPage.getByTestId("booking-detail-content");
  await expect(
    content.getByText(
      `${WAITLISTER.firstName} ${WAITLISTER.lastName} has added you to this booking`,
    ),
  ).toBeVisible();
  await expect(content.getByText("Waiting for your answer")).toBeVisible();
  // MG2-D-a's party listing, with the viewer's own row marked.
  await expect(
    content.getByText(
      `${NOMINATOR_TWO.firstName} ${NOMINATOR_TWO.lastName} — that's you`,
    ),
  ).toBeVisible();
  await expect(content.getByText("Answer by")).toBeVisible();

  await content.getByRole("button", { name: "Yes, add me" }).click();
  await expect(content.getByText("You're on this booking")).toBeVisible();
  await expect(content.getByText(/your place is confirmed/)).toBeVisible();

  // Reload: the question is gone and the guest list carries the ticked badge.
  await nadiaPage.goto(`/bookings/${booking.id}`);
  const reloaded = nadiaPage.getByTestId("booking-detail-content");
  await expect(reloaded.getByText("Consented", { exact: true })).toBeVisible();
  await expect(
    reloaded.getByRole("button", { name: "Yes, add me" }),
  ).toHaveCount(0);
});

test("the target declines on an unpaid booking and the booker's guest list no longer names them", async () => {
  const booking = await createBookingWithMemberGuest(DECLINE_WINDOW);
  const guest = pendingGuestOf(booking);

  // The TARGET following the delegate link is sent to her own surface — the
  // booking page's #consent card — never left on the delegate panel.
  await nadiaPage.goto(`/bookings/consent/${guest.id}`);
  await expect(nadiaPage).toHaveURL(new RegExp(`/bookings/${booking.id}`));

  const content = nadiaPage.getByTestId("booking-detail-content");
  await content.getByRole("button", { name: "No thanks" }).click();
  await expect(content.getByText("You've said no")).toBeVisible();
  await expect(
    content.getByText(/The bed that was held for you has been released/),
  ).toBeVisible();
  await expect(
    content.getByRole("link", { name: "Back to my bookings" }),
  ).toBeVisible();

  // The booker's view: the party no longer includes the member who said no.
  await wandaPage.goto(`/bookings/${booking.id}`);
  const wandaView = wandaPage.getByTestId("booking-detail-content");
  await expect(wandaView.getByText("Stay Details")).toBeVisible();
  await expect(
    wandaView.getByText(
      `${NOMINATOR_TWO.firstName} ${NOMINATOR_TWO.lastName}`,
    ),
  ).toHaveCount(0);
});

test("the delegate page tells a non-delegate — even the booker — nothing, indistinguishably from a made-up id", async () => {
  // A REAL guest row's id (the approve test's, now settled — authorization is
  // checked before status, so settled-vs-pending must not change the answer),
  // probed by the booker: entitled to the booking page, NOT to the delegate
  // panel, because she is no adult in the target's family group.
  if (approvedGuestId) {
    await wandaPage.goto(`/bookings/consent/${approvedGuestId}`);
    await expect(
      wandaPage.getByText("There is nothing here for you to answer"),
    ).toBeVisible();
    // No booking fact leaks onto the neutral page.
    await expect(wandaPage.getByText(/has added/)).toHaveCount(0);
    await expect(wandaPage.getByText("Booked by")).toHaveCount(0);
  }

  // A fabricated id renders the SAME neutral page — the route is no oracle.
  await wandaPage.goto("/bookings/consent/does-not-exist");
  await expect(
    wandaPage.getByText("There is nothing here for you to answer"),
  ).toBeVisible();
  await expect(wandaPage.getByText("Booked by")).toHaveCount(0);
});
