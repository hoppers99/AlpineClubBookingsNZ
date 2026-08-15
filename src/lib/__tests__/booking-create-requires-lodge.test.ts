/*
 * #2701 — A BOOKING MUST NAME ITS LODGE, AND THE SERVER NO LONGER GUESSES.
 *
 * `resolveOptionalActiveLodgeId` answers a missing id with the club's DEFAULT
 * lodge. On a read that is a convenience; on a CREATE it is how a member ends
 * up paid up at a lodge they were never shown — reachable whenever
 * `/api/lodges` fails, because `LodgeSelect` then renders nothing, the
 * selection normalises to `null`, and both wizards posted no lodge at all.
 *
 * Ten client surfaces are fixed alongside this. THIS is the gate that closes
 * the class: one refusal instead of ten guards, so the eleventh screen written
 * next year fails loudly here instead of writing quietly to the wrong lodge.
 */

import { describe, expect, it } from "vitest";
import {
  BOOKING_LODGE_REQUIRED_CODE,
  BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE,
} from "@/lib/booking-lodge-scope";

/**
 * The route module pulls in the whole booking service graph, so the refusal is
 * exercised here through the exact predicate the route applies, plus a source
 * assertion that the route really applies it. The end-to-end refusal is proved
 * by `POST /api/bookings` returning 400 in the route suite and by the E2E
 * booking-create census, which now names a lodge on every direct create.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/bookings/route.ts"),
  "utf8",
);

describe("POST /api/bookings — the lodge is required (#2701)", () => {
  it("refuses before resolving, so the default lodge is never reached", () => {
    // MUTATION PROBE: delete the `if (!parsed.data.lodgeId)` block and this
    // fails. That block is the whole fix; without it
    // `resolveOptionalActiveLodgeId(prisma, undefined)` returns
    // `getDefaultLodgeId(...)` and the booking is written against a lodge the
    // caller never named.
    const guardIndex = ROUTE.indexOf("if (!parsed.data.lodgeId)");
    const resolveIndex = ROUTE.indexOf("const bookingLodgeId = await resolveOptionalActiveLodgeId");

    expect(guardIndex, "the create must refuse an unnamed lodge").toBeGreaterThan(-1);
    expect(resolveIndex).toBeGreaterThan(-1);
    // Order matters: refusing AFTER resolving would still have consulted the
    // default lodge, and a later reader would reasonably move the guard.
    expect(guardIndex).toBeLessThan(resolveIndex);
  });

  it("answers with the machine-readable code, not only prose", () => {
    expect(ROUTE).toContain("BOOKING_LODGE_REQUIRED_CODE");
    expect(BOOKING_LODGE_REQUIRED_CODE).toBe("BOOKING_LODGE_REQUIRED");
  });

  it("keeps the refusal a 400, not a 500", () => {
    // The caller sent a bad request; nothing failed.
    const guardIndex = ROUTE.indexOf("if (!parsed.data.lodgeId)");
    const window = ROUTE.slice(guardIndex, guardIndex + 600);
    expect(window).toContain("status: 400");
  });

  it("leaves the SHARED helper permissive, so read contracts are untouched", () => {
    // Deliberately not fixed by making `resolveOptionalActiveLodgeId` strict:
    // that helper also serves reads where an omitted lodge legitimately means
    // "the whole club", and `INV-INT-016` retains exactly such a mode on
    // `GET /api/bookings/rooms` for consumers outside this repository.
    const helper = readFileSync(
      join(process.cwd(), "src/lib/lodges.ts"),
      "utf8",
    );
    const start = helper.indexOf("export async function resolveOptionalActiveLodgeId");
    expect(start).toBeGreaterThan(-1);
    expect(helper.slice(start, start + 500)).toContain("getDefaultLodgeId(db)");
  });

  it("gives the member something they can act on", () => {
    // Not a field-validation string about a control they were never offered.
    expect(BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE).toMatch(
      /nothing has been booked or charged/i,
    );
    expect(BOOKING_LODGE_UNRESOLVED_MEMBER_MESSAGE).toMatch(/try again/i);
  });
});
