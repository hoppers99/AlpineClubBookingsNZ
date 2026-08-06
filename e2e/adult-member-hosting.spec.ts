import { type APIRequestContext, type BrowserContext, expect, test } from "@playwright/test";

import { loginPersona, storageStatePath } from "./helpers/auth";
import { E2E_ADMIN, WAITLISTER } from "./helpers/fixtures";
import {
  overrideModules,
  setModuleSettings,
  type ModuleSettings,
} from "./helpers/modules";
import { cancelMemberBookingsOnDate } from "./helpers/reset";
import { stayWindowForAttempt } from "./helpers/stay-dates";

/**
 * #2569 / #2576 — the adult-member hosting rule end to end against the real app.
 *
 * Three things only production-mode running can show, and each is an acceptance
 * criterion rather than a nice-to-have:
 *
 *  1. THE SETTINGS CARD'S TWO DIMENSIONS (#2569). The consequence and the
 *     host-scope set resolve INDEPENDENTLY and each reports its own source. Unit
 *     tests pin the resolver; only the running app can show the saved values coming
 *     back through the API and being stated on the card the operator reads.
 *  2. THE ENFORCED REFUSAL (#2569 §1). A booking that breaks the rule is REFUSED
 *     rather than recorded for review — a real 409 from the real create path, with
 *     the reason code a client can act on. A unit test can only show the evaluator
 *     returning a violation; it cannot show the booking failing to exist.
 *  3. SAME-OWNER COVERAGE AND THE REFUSED CHANGE (#2576). A second booking on the
 *     SAME member account supplies the adult member, so a booking that would
 *     otherwise be refused is accepted; and cancelling that source booking is then
 *     refused, because it would leave the first one uncovered. This is the whole
 *     point of the scope and it is intrinsically multi-booking, so it cannot be
 *     shown anywhere but here.
 *
 * DRIVEN THROUGH THE PRODUCT'S OWN APIs, with one UI assertion. Same reasoning as
 * `policy-exception-approval.spec.ts`: the booking wizard is covered by
 * `booking.spec.ts`, and driving the state changes by API keeps this spec about the
 * POLICY semantics rather than about form clicking. The one page visit is the
 * operator-facing card, because "the card states what is actually in force" is
 * itself the requirement.
 *
 * SELF-RESTORING. The club-wide hosting policy is a real club setting that every
 * other spec's bookings run through, so it is put back to DISABLED in `afterAll`
 * whatever happens, and the bookings this spec creates are cancelled by member and
 * date the same way the rest of the suite cleans up.
 */

test.describe.configure({ mode: "serial" });

const MEMBER_NAME = `${WAITLISTER.firstName} ${WAITLISTER.lastName}`;

let adminContext: BrowserContext;
let memberContext: BrowserContext;
let admin: APIRequestContext;
let member: APIRequestContext;
let ownerMemberId: string;
let previousModules: ModuleSettings | null = null;

/** A future in-season window with room, chosen once so both bookings share it. */
let WINDOW: { checkIn: string; checkOut: string };

/** Booking ids to clear even if a step failed part-way. */
const createdBookingIds: string[] = [];

type HostScopes = { sameBooking: boolean; sameBookingOwner: boolean };

/**
 * Every status the admin booking list can filter on (its own `VALID_STATUSES`).
 * `AWAITING_REVIEW` is deliberately absent from that set in the route, so it
 * cannot be listed at all — the same limitation `e2e/helpers/reset.ts` records.
 */
const LISTABLE_STATUSES = [
  "DRAFT",
  "PENDING",
  "PAYMENT_PENDING",
  "CONFIRMED",
  "PAID",
  "COMPLETED",
  "CANCELLED",
  "BUMPED",
  "WAITLISTED",
  "WAITLIST_OFFERED",
].join(",");

/**
 * Save the club-wide hosting policy, carrying the revision we just read.
 *
 * The route compare-and-swaps on that revision, so reading first is not
 * defensiveness — a blind write is refused, which is the behaviour #2569 wanted.
 */
async function setClubHostingPolicy(options: {
  mode: "DISABLED" | "ADMIN_REVIEW_REQUIRED" | "ENFORCED";
  hostScopes: HostScopes | null;
}): Promise<void> {
  const current = await admin.get(
    "/api/admin/booking-policies/adult-member-hosting",
  );
  expect(
    current.ok(),
    `read hosting policy (${current.status()}): ${await current.text()}`,
  ).toBeTruthy();
  // The keyed settings route returns the selected row at the response root
  // (with `version: 0` for the synthesized never-saved state), not under a
  // `club` envelope. Carry every positive revision so the second write is a
  // genuine compare-and-swap instead of an accidental blind-create attempt.
  const body = (await current.json()) as { version?: number };

  const saved = await admin.put(
    "/api/admin/booking-policies/adult-member-hosting",
    {
      data: {
        mode: options.mode,
        hostScopes: options.hostScopes,
        capacityMode: "NO_HOLD",
        ...(body.version ? { version: body.version } : {}),
      },
    },
  );
  expect(
    saved.ok(),
    `save hosting policy ${options.mode} (${saved.status()}): ${await saved.text()}`,
  ).toBeTruthy();
}

async function readClubHostingPolicy(): Promise<{
  mode: string;
  hostScopes: HostScopes;
  modeSource: string;
  hostScopeSource: string;
}> {
  const res = await admin.get("/api/admin/booking-policies/adult-member-hosting");
  expect(res.ok(), `read hosting policy (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as {
    effective: {
      mode: string;
      hostScopes: HostScopes;
      modeSource: string;
      hostScopeSource: string;
    };
  };
  return body.effective;
}

async function resolveOwnerMemberId(): Promise<string> {
  const res = await admin.get(
    `/api/admin/members?search=${encodeURIComponent(WAITLISTER.email)}&pageSize=5`,
  );
  expect(res.ok(), `resolve booking member (${res.status()})`).toBeTruthy();
  const body = (await res.json()) as {
    members?: Array<{ id: string; email: string }>;
  };
  const match = (body.members ?? []).find(
    (candidate) => candidate.email === WAITLISTER.email,
  );
  expect(match?.id, "the booking persona must resolve to a member id").toBeTruthy();
  return match!.id;
}

/** Create a booking as the member, returning the response for the caller to judge. */
function createMemberBooking(guests: Array<Record<string, unknown>>) {
  return member.post("/api/bookings", {
    data: {
      checkIn: WINDOW.checkIn,
      checkOut: WINDOW.checkOut,
      guests,
    },
  });
}

/**
 * Create the active source on behalf of the owner. This reaches CONFIRMED without
 * live Stripe, and deliberately makes `createdById` differ from `Booking.memberId`:
 * if coverage accidentally keys on the creator, the dependent below is refused.
 */
function createCoveringBooking() {
  return admin.post("/api/bookings", {
    data: {
      checkIn: WINDOW.checkIn,
      checkOut: WINDOW.checkOut,
      forMemberId: ownerMemberId,
      paymentMethod: "internet_banking",
      guests: [
        {
          firstName: WAITLISTER.firstName,
          lastName: WAITLISTER.lastName,
          ageTier: "ADULT",
          isMember: true,
          memberId: ownerMemberId,
        },
      ],
    },
  });
}

/**
 * Every live booking this member owns that checks in on our window, read through
 * the ADMIN list because that is the only booking-listing API the product exposes
 * (`e2e/helpers/reset.ts` reads the same one for the same reason).
 */
async function memberBookingsOnWindow(): Promise<
  Array<{ id: string; status: string; checkIn: string }>
> {
  const calendarMonth = WINDOW.checkIn.slice(0, 7);
  // An EXPLICIT status list rather than `status=all`, because that value falls
  // through to the route's default filter and quietly excludes DRAFT — and "the
  // refused booking does not exist in ANY status" is precisely the assertion that
  // needs to see a draft if one was left behind.
  const listed = await admin.get(
    `/api/admin/bookings?calendarMonth=${calendarMonth}&status=${LISTABLE_STATUSES}`,
  );
  expect(
    listed.ok(),
    `GET /api/admin/bookings?calendarMonth=${calendarMonth} (${listed.status()})`,
  ).toBeTruthy();
  const body = (await listed.json()) as {
    bookings: Array<{
      id: string;
      memberName: string;
      checkIn: string;
      status: string;
      deletedAt: string | null;
    }>;
  };
  return body.bookings
    .filter(
      (booking) =>
        booking.memberName === MEMBER_NAME &&
        booking.checkIn === WINDOW.checkIn &&
        !booking.deletedAt,
    )
    // CANCELLED rows are kept: the override step below asserts that the dependent
    // booking is NOT cancelled, which only means something if a cancelled row would
    // have been visible here.

    .map((booking) => ({
      id: booking.id,
      status: booking.status,
      checkIn: booking.checkIn,
    }));
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  adminContext = await browser.newContext({
    storageState: storageStatePath(E2E_ADMIN.email),
  });
  admin = adminContext.request;
  // These bookings use Internet Banking so an all-member source reaches a
  // confirmed active-attendance state without live Stripe. The isolated seed
  // leaves both switches off; restore the exact snapshot in afterAll.
  previousModules = await overrideModules(admin, {
    xeroIntegration: true,
    internetBankingPayments: true,
  });

  // Wanda is seeded PAID with a complete, confirmed profile. Alice's booking
  // setup deliberately completes her profile in another spec, so using Alice
  // here would make this focused file depend on repository-wide execution order.
  memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await loginPersona(memberPage, WAITLISTER.email, "198.51.100.69");
  member = memberContext.request;
  ownerMemberId = await resolveOwnerMemberId();

  // `stayWindowForAttempt` hands out a distinct in-season window per spec/attempt,
  // which is what keeps concurrent specs off each other's capacity.
  const window = stayWindowForAttempt(9, test.info().retry);
  WINDOW = { checkIn: window.checkIn, checkOut: window.checkOut };

  // Start from a clean slate for this member and window: a leftover from a
  // previous attempt would supply cover and make the refusal cases pass for the
  // wrong reason.
  await cancelMemberBookingsOnDate(admin, {
    memberName: MEMBER_NAME,
    checkIn: WINDOW.checkIn,
  });
});

test.afterAll(async () => {
  // Put the club setting back FIRST: it gates every other spec's bookings, and a
  // failure below must not leave the club refusing them.
  try {
    await setClubHostingPolicy({ mode: "DISABLED", hostScopes: null });
  } finally {
    try {
      await cancelMemberBookingsOnDate(admin, {
        memberName: MEMBER_NAME,
        checkIn: WINDOW.checkIn,
      }).catch(() => undefined);
    } finally {
      try {
        if (previousModules) await setModuleSettings(admin, previousModules);
      } finally {
        await adminContext?.close();
        await memberContext?.close();
      }
    }
  }
});

test("the card resolves and states the two dimensions independently (#2569)", async () => {
  await setClubHostingPolicy({
    mode: "ADMIN_REVIEW_REQUIRED",
    hostScopes: { sameBooking: true, sameBookingOwner: false },
  });
  let effective = await readClubHostingPolicy();
  expect(effective.mode).toBe("ADMIN_REVIEW_REQUIRED");
  expect(effective.hostScopes).toEqual({
    sameBooking: true,
    sameBookingOwner: false,
  });

  // Move ONE dimension. The other must not follow it — that independence is the
  // whole shape of #2569's model, and a resolver that coupled them would still
  // pass every single-dimension test.
  await setClubHostingPolicy({
    mode: "ENFORCED",
    hostScopes: { sameBooking: true, sameBookingOwner: true },
  });
  effective = await readClubHostingPolicy();
  expect(effective.mode).toBe("ENFORCED");
  expect(effective.hostScopes).toEqual({
    sameBooking: true,
    sameBookingOwner: true,
  });
  expect(effective.modeSource).toBe("CLUB_WIDE");
  expect(effective.hostScopeSource).toBe("CLUB_WIDE");

  // ...and the operator's own card says so, in the words they will read.
  const page = await adminContext.newPage();
  await page.goto("/admin/booking-policies/adult-member-hosting");
  const inForce = page.getByText("In force here now").first();
  await expect(inForce).toBeVisible();
  const panel = page
    .locator("div")
    .filter({ hasText: "In force here now" })
    .last();
  await expect(panel).toContainText("Another booking on the same account");
  await page.close();
});

test("an enforcing club refuses a booking with no adult member cover (#2569 §1)", async () => {
  const refused = await createMemberBooking([
    { firstName: "Hosting", lastName: "Guest", ageTier: "ADULT", isMember: false },
  ]);
  expect(
    refused.status(),
    `uncovered booking must be refused, not recorded (${refused.status()}): ` +
      `${await refused.text()}`,
  ).toBe(409);
  const body = (await refused.json()) as { code?: string; error?: string };
  expect(body.code).toBe("ADULT_MEMBER_HOSTING_REQUIRED");
  // The refusal is actionable: it names the nights and offers the exception door.
  expect(body.error ?? "").toMatch(/adult member/i);

  // AND THE BOOKING DOES NOT EXIST IN ANY STATUS. This is the assertion a unit test
  // cannot make, and it is the whole difference between the enforced consequence and
  // the review one: under review there would be a booking here, waiting.
  const live = (await memberBookingsOnWindow()).filter(
    // CANCELLED is excluded HERE and only here: `beforeAll` clears the window by
    // cancelling rather than deleting, so a cancelled row is evidence of the
    // cleanup, not of a booking this refusal should have prevented.
    (row) => row.status !== "CANCELLED",
  );
  expect(
    live,
    "the refused booking must not have been created in any live status",
  ).toEqual([]);
});

test("another booking on the same account supplies the cover, and cannot then be pulled away (#2576)", async () => {
  // 1. THE SOURCE. A booking carrying the member themselves, who is a qualifying
  //    adult member attending those exact nights at that exact lodge.
  const source = await createCoveringBooking();
  expect(
    source.ok(),
    `create the covering booking (${source.status()}): ${await source.text()}`,
  ).toBeTruthy();
  const sourceBooking = (await source.json()) as { id: string; status: string };
  createdBookingIds.push(sourceBooking.id);
  // Only genuinely confirmed active attendance may cover (§3), so the premise of
  // the next step is that this booking really reached one of those states.
  expect(
    ["CONFIRMED", "PAID"],
    `covering booking must be confirmed active attendance (got ${sourceBooking.status})`,
  ).toContain(sourceBooking.status);

  // 2. THE DEPENDENT. The same party shape that was refused above — and this time
  //    it is accepted, because the adult member on the other booking covers every
  //    night of it.
  const dependent = await createMemberBooking([
    { firstName: "Covered", lastName: "Guest", ageTier: "ADULT", isMember: false },
  ]);
  expect(
    dependent.ok(),
    `same-owner cover must allow this booking (${dependent.status()}): ` +
      `${await dependent.text()}`,
  ).toBeTruthy();
  const dependentBooking = (await dependent.json()) as { id: string };
  createdBookingIds.push(dependentBooking.id);

  // 3. THE REFUSED CHANGE (§6). Cancelling the source would strand the dependent,
  //    so the member's own cancel is refused — and the source is left untouched.
  const blocked = await member.post(`/api/bookings/${sourceBooking.id}/cancel`, {
    data: { refundMethod: "credit" },
  });
  expect(
    blocked.status(),
    `stranding cancel must be refused (${blocked.status()}): ${await blocked.text()}`,
  ).toBe(409);
  const blockedBody = (await blocked.json()) as {
    code?: string;
    strandedBookings?: Array<{ bookingId: string; nights: string[] }>;
  };
  expect(blockedBody.code).toBe("SAME_OWNER_COVERAGE_WOULD_BREAK");
  // It names the member's OWN affected booking and the exact nights — the thing
  // they need in order to fix it.
  expect(
    (blockedBody.strandedBookings ?? []).map((row) => row.bookingId),
  ).toContain(dependentBooking.id);
  expect(
    (blockedBody.strandedBookings ?? [])[0]?.nights ?? [],
  ).toContain(WINDOW.checkIn);

  // The rollback is real: the source booking is still live and still confirmed.
  const afterRefusal = await memberBookingsOnWindow();
  const survivor = afterRefusal.find((row) => row.id === sourceBooking.id);
  expect(survivor, "the refused cancel must have rolled back").toBeTruthy();
  expect(["CONFIRMED", "PAID"]).toContain(survivor!.status);

  // 4. AN OFFICER IS NOT REFUSED (§7). The same cancellation, by an admin, goes
  //    through — the dependent booking keeps its status rather than being cancelled
  //    with it, and the club's record of the problem is the officer queue.
  const overridden = await admin.post(
    `/api/bookings/${sourceBooking.id}/cancel`,
    { data: { refundMethod: "credit", notifyMember: false } },
  );
  expect(
    overridden.ok(),
    `officer cancel must be allowed (${overridden.status()}): ${await overridden.text()}`,
  ).toBeTruthy();
  const afterOverride = await memberBookingsOnWindow();
  const dependentRow = afterOverride.find(
    (row) => row.id === dependentBooking.id,
  );
  expect(
    dependentRow,
    "the dependent booking must still be there after the override",
  ).toBeTruthy();
  expect(
    dependentRow!.status,
    "the dependent booking must NOT be cancelled automatically (§7, §16)",
  ).not.toBe("CANCELLED");
});
