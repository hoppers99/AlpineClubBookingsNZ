import { type APIRequestContext, type BrowserContext, expect, test } from "@playwright/test";

import { loginPersona } from "../helpers/auth";
import { E2E_ADMIN, SECOND_LODGE, WAITLISTER } from "../helpers/fixtures";

/**
 * Multi-lodge coverage for TLR-8C (#2526): a booking-policy exception is decided
 * and EXECUTED at the lodge it was frozen against.
 *
 * The failure this exists to catch is a lodge leak — a rule configured for one
 * lodge stopping bookings at another, or an approval creating the booking at the
 * club's default lodge because that is what a missing `lodgeId` falls back to.
 * The proposal freezes its lodge, and the approval's capacity recheck and
 * canonical create must both use THAT lodge.
 *
 * Runs only in the `multi-lodge` project (E2E_MULTI_LODGE=1), which has no auth
 * setup dependency, so both actors log in for themselves.
 */

test.describe.configure({ mode: "serial" });

const POLICY_NAME = "E2E lodge-B policy exception minimum stay";
const MEMBER_NAME = `${WAITLISTER.firstName} ${WAITLISTER.lastName}`;

let adminContext: BrowserContext;
let memberContext: BrowserContext;
let admin: APIRequestContext;
let lodgeBId: string;
let memberId: string;
let stay: { checkIn: string; checkOut: string };

function dateOnly(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate(),
  ).padStart(2, "0")}`;
}

async function deleteSpecPolicies(api: APIRequestContext, lodgeId: string) {
  const response = await api.get(
    `/api/admin/booking-policies/minimum-stay?lodgeId=${encodeURIComponent(lodgeId)}`,
  );
  if (!response.ok()) return;
  const policies = (await response.json()) as Array<{ id: string; name: string }>;
  for (const policy of policies) {
    if (policy.name.startsWith(POLICY_NAME)) {
      await api.delete(`/api/admin/booking-policies/minimum-stay/${policy.id}`);
    }
  }
}

async function cancelOpenRequests(member: APIRequestContext) {
  const listed = await member.get("/api/bookings/exception-requests");
  if (!listed.ok()) return;
  const rows = (await listed.json()) as Array<{ id: string; status: string }>;
  for (const row of rows) {
    if (row.status === "REQUESTED") {
      await member.patch(`/api/bookings/exception-requests/${row.id}`, {
        data: { action: "cancel" },
      });
    }
  }
}

test.beforeAll(async ({ browser }) => {
  // A fresh login incl. first-time two-factor enrollment needs more than the
  // default hook budget on a loaded CI runner.
  test.setTimeout(240_000);

  adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  await loginPersona(adminPage, E2E_ADMIN.email);
  await adminPage.close();
  admin = adminContext.request;

  memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await loginPersona(memberPage, WAITLISTER.email);
  await memberPage.close();

  const lodges = await memberContext.request.get("/api/lodges");
  expect(lodges.ok(), "/api/lodges must succeed for a signed-in member").toBeTruthy();
  const body = (await lodges.json()) as { lodges: Array<{ id: string; name: string }> };
  const lodgeB = body.lodges.find((lodge) => lodge.name === SECOND_LODGE.name);
  expect(lodgeB, "the seeded second lodge must be bookable").toBeTruthy();
  lodgeBId = (lodgeB as { id: string }).id;

  const members = await admin.get(
    `/api/admin/members?search=${encodeURIComponent(WAITLISTER.email)}&pageSize=5`,
  );
  expect(members.ok()).toBeTruthy();
  const memberBody = (await members.json()) as {
    members: Array<{ id: string; email: string }>;
  };
  memberId = (
    memberBody.members.find(
      (row) => row.email.toLowerCase() === WAITLISTER.email.toLowerCase(),
    ) as { id: string }
  ).id;

  // A one-night stay well clear of every seeded fixture window.
  const start = new Date();
  start.setDate(start.getDate() + 45);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  stay = { checkIn: dateOnly(start), checkOut: dateOnly(end) };

  await deleteSpecPolicies(admin, lodgeBId);
  await cancelOpenRequests(memberContext.request);

  // Two-night minimum AT LODGE B ONLY. A per-lodge row REPLACES the club-wide
  // set for that lodge, so lodge A is untouched by it.
  const created = await admin.post("/api/admin/booking-policies/minimum-stay", {
    data: {
      name: POLICY_NAME,
      startDate: "2020-01-01",
      endDate: "2099-12-31",
      triggerDays: [0, 1, 2, 3, 4, 5, 6],
      minimumNights: 2,
      capacityMode: "NO_HOLD",
      active: true,
      lodgeId: lodgeBId,
    },
  });
  expect(
    created.ok(),
    `lodge-B minimum-stay policy create: ${created.status()} ${await created.text()}`,
  ).toBeTruthy();
});

test.afterAll(async () => {
  if (admin && lodgeBId) {
    await cancelOpenRequests(memberContext.request);
    await deleteSpecPolicies(admin, lodgeBId);
  }
  await adminContext?.close();
  await memberContext?.close();
});

test("an exception raised at the second lodge is approved and executed AT that lodge", async () => {
  const submitted = await memberContext.request.post(
    "/api/bookings/exception-requests",
    {
      data: {
        lodgeId: lodgeBId,
        checkIn: stay.checkIn,
        checkOut: stay.checkOut,
        guests: [
          {
            firstName: WAITLISTER.firstName,
            lastName: WAITLISTER.lastName,
            ageTier: "ADULT",
            isMember: true,
            memberId,
          },
        ],
        memberMessage: "One night at the second lodge, driving back the next day.",
      },
    },
  );
  expect(
    submitted.status(),
    `lodge-B exception request: ${await submitted.text()}`,
  ).toBe(201);
  const request = (await submitted.json()) as { id: string; reasonCodes: string[] };
  expect(request.reasonCodes).toContain("MINIMUM_STAY");

  const queue = await admin.get(
    "/api/admin/booking-exception-requests?status=REQUESTED&pageSize=100",
  );
  expect(queue.ok()).toBeTruthy();
  const queued = ((await queue.json()) as {
    data: Array<{ id: string; version: number; lodgeId: string | null }>;
  }).data.find((row) => row.id === request.id);
  expect(queued, "the lodge-B request must reach the officer queue").toBeTruthy();
  // The queue reports the lodge the proposal was FROZEN against, not the club default.
  expect(queued?.lodgeId).toBe(lodgeBId);

  const approved = await admin.patch(
    `/api/admin/booking-exception-requests/${request.id}`,
    {
      data: {
        action: "approve",
        source: "NEW_BOOKING",
        expectedVersion: queued?.version,
        confirm: true,
        adminNotes: "Second lodge has room; one night is fine there.",
      },
    },
  );
  expect(approved.status(), `approve: ${await approved.text()}`).toBe(200);
  const outcome = (await approved.json()) as { createdBookingId: string | null };
  expect(outcome.createdBookingId).toBeTruthy();

  // The booking landed at LODGE B, not at the club's default lodge.
  const calendarMonth = stay.checkIn.slice(0, 7);
  const listed = await admin.get(
    `/api/admin/bookings?calendarMonth=${calendarMonth}&status=PAYMENT_PENDING,PENDING`,
  );
  expect(listed.ok(), `admin bookings list: ${await listed.text()}`).toBeTruthy();
  const bookings = ((await listed.json()) as {
    bookings: Array<{
      id: string;
      memberName: string;
      checkIn: string;
      lodgeId?: string | null;
      lodgeName?: string | null;
    }>;
  }).bookings.filter(
    (booking) =>
      booking.id === outcome.createdBookingId ||
      (booking.memberName === MEMBER_NAME && booking.checkIn === stay.checkIn),
  );
  expect(
    bookings.length,
    "the approval must have created exactly one booking on that night",
  ).toBe(1);
  const created = bookings[0];
  // Whichever shape the list exposes, the lodge must be the second lodge.
  const lodgeMatches =
    created.lodgeId === lodgeBId || created.lodgeName === SECOND_LODGE.name;
  expect(
    lodgeMatches,
    `the created booking must belong to ${SECOND_LODGE.name}: ${JSON.stringify(created)}`,
  ).toBeTruthy();

  // Clean up so a retry starts from the same place.
  await admin.post(`/api/bookings/${outcome.createdBookingId}/cancel`, {
    data: { refundMethod: "credit", notifyMember: false },
  });
});
