import { describe, expect, it, vi } from "vitest";
import { parseDateOnly, formatDateOnly } from "@/lib/date-only";
import {
  buildPolicyExceptionReservationNightIndex,
  buildLodgePolicyExceptionReservationCounter,
  findActivePolicyExceptionReservationNights,
  releasePolicyExceptionReservation,
  reservePolicyExceptionCapacity,
} from "@/lib/booking-exception-reservations";
import {
  computeProposalReservation,
  type ModificationProposalSnapshot,
  type NewBookingProposalSnapshot,
} from "@/lib/booking-exception-requests";

const LODGE = "lodge-a";

function guest(nights: string[], memberId: string | null = null) {
  return {
    firstName: "A",
    lastName: "B",
    ageTier: "ADULT",
    isMember: memberId != null,
    memberId,
    nights,
  };
}

describe("policy-exception reservation store", () => {
  describe("reservePolicyExceptionCapacity", () => {
    it("writes one upsert per reserved night with the full new-booking footprint", async () => {
      const upsert = vi.fn().mockResolvedValue({});
      const snapshot: NewBookingProposalSnapshot = {
        kind: "NEW_BOOKING",
        lodgeId: LODGE,
        proposed: {
          checkIn: "2026-07-01",
          checkOut: "2026-07-03",
          guests: [guest(["2026-07-01", "2026-07-02"]), guest(["2026-07-01"])],
        },
      };

      const written = await reservePolicyExceptionCapacity(
        { policyExceptionReservationNight: { upsert } } as never,
        { changeRequestId: "req-1", lodgeId: LODGE, snapshot },
      );

      // Two guests on 07-01, one on 07-02 => beds {07-01:2, 07-02:1}.
      expect(written).toEqual([
        { night: "2026-07-01", beds: 2 },
        { night: "2026-07-02", beds: 1 },
      ]);
      expect(upsert).toHaveBeenCalledTimes(2);
      const firstArgs = upsert.mock.calls[0][0];
      expect(firstArgs.where.changeRequestId_night.changeRequestId).toBe("req-1");
      expect(formatDateOnly(firstArgs.where.changeRequestId_night.night)).toBe(
        "2026-07-01",
      );
      expect(firstArgs.create.beds).toBe(2);
      expect(firstArgs.create.lodgeId).toBe(LODGE);
    });

    it("reserves ONLY the incremental beds beyond the live booking for a modification", async () => {
      const upsert = vi.fn().mockResolvedValue({});
      // Live: 1 guest each of 07-01, 07-02. Proposed: 2 guests on 07-01, 1 on
      // 07-02, plus a new night 07-03. Incremental => {07-01:1, 07-03:1}.
      const snapshot: ModificationProposalSnapshot = {
        kind: "MODIFICATION",
        lodgeId: LODGE,
        bookingId: "bk-1",
        base: {
          checkIn: "2026-07-01",
          checkOut: "2026-07-03",
          guests: [guest(["2026-07-01", "2026-07-02"])],
        },
        proposed: {
          checkIn: "2026-07-01",
          checkOut: "2026-07-04",
          guests: [
            guest(["2026-07-01", "2026-07-02", "2026-07-03"]),
            guest(["2026-07-01"]),
          ],
        },
      };
      expect(computeProposalReservation(snapshot)).toEqual([
        { night: "2026-07-01", beds: 1 },
        { night: "2026-07-03", beds: 1 },
      ]);

      const written = await reservePolicyExceptionCapacity(
        { policyExceptionReservationNight: { upsert } } as never,
        { changeRequestId: "req-2", lodgeId: LODGE, snapshot },
      );
      expect(written).toEqual([
        { night: "2026-07-01", beds: 1 },
        { night: "2026-07-03", beds: 1 },
      ]);
      expect(upsert).toHaveBeenCalledTimes(2);
    });

    it("writes NOTHING when the modification only shrinks the party (NO_HOLD-shaped)", async () => {
      const upsert = vi.fn().mockResolvedValue({});
      const snapshot: ModificationProposalSnapshot = {
        kind: "MODIFICATION",
        lodgeId: LODGE,
        bookingId: "bk-1",
        base: {
          checkIn: "2026-07-01",
          checkOut: "2026-07-02",
          guests: [guest(["2026-07-01"]), guest(["2026-07-01"])],
        },
        proposed: {
          checkIn: "2026-07-01",
          checkOut: "2026-07-02",
          guests: [guest(["2026-07-01"])],
        },
      };
      const written = await reservePolicyExceptionCapacity(
        { policyExceptionReservationNight: { upsert } } as never,
        { changeRequestId: "req-3", lodgeId: LODGE, snapshot },
      );
      expect(written).toEqual([]);
      expect(upsert).not.toHaveBeenCalled();
    });
  });

  describe("releasePolicyExceptionReservation", () => {
    it("deletes every night row for the request and returns the count", async () => {
      const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
      const released = await releasePolicyExceptionReservation(
        { policyExceptionReservationNight: { deleteMany } } as never,
        "req-9",
      );
      expect(released).toBe(3);
      expect(deleteMany).toHaveBeenCalledWith({
        where: { changeRequestId: "req-9" },
      });
    });
  });

  describe("buildPolicyExceptionReservationNightIndex", () => {
    it("SUMS beds across several requests reserving the same night", () => {
      const nights = ["2026-07-01", "2026-07-02"].map(parseDateOnly);
      const rows = [
        { night: parseDateOnly("2026-07-01"), beds: 2 },
        { night: parseDateOnly("2026-07-01"), beds: 1 },
        { night: parseDateOnly("2026-07-02"), beds: 1 },
      ];
      const index = buildPolicyExceptionReservationNightIndex(rows, nights);
      expect(index.get("2026-07-01")).toBe(3);
      expect(index.get("2026-07-02")).toBe(1);
    });
  });

  describe("buildLodgePolicyExceptionReservationCounter", () => {
    it("returns per-night reserved bed counts, keyed to the lodge/window", async () => {
      const findMany = vi.fn().mockResolvedValue([
        { night: parseDateOnly("2026-07-01"), beds: 2 },
        { night: parseDateOnly("2026-07-02"), beds: 1 },
      ]);
      const nights = ["2026-07-01", "2026-07-02", "2026-07-03"].map(parseDateOnly);
      const counter = await buildLodgePolicyExceptionReservationCounter({
        lodgeId: LODGE,
        from: parseDateOnly("2026-07-01"),
        toExclusive: parseDateOnly("2026-07-04"),
        nights,
        db: { policyExceptionReservationNight: { findMany } } as never,
      });
      expect(counter(parseDateOnly("2026-07-01"))).toBe(2);
      expect(counter(parseDateOnly("2026-07-02"))).toBe(1);
      expect(counter(parseDateOnly("2026-07-03"))).toBe(0);
    });

    it("excludes a specific request's own reservation when asked", async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      await findActivePolicyExceptionReservationNights({
        lodgeId: LODGE,
        from: parseDateOnly("2026-07-01"),
        toExclusive: parseDateOnly("2026-07-04"),
        db: { policyExceptionReservationNight: { findMany } } as never,
        excludeChangeRequestId: "req-self",
      });
      expect(findMany.mock.calls[0][0].where.changeRequestId).toEqual({
        not: "req-self",
      });
    });

    it("tolerates a db WITHOUT the delegate (partial test double) as zero reservations", async () => {
      const counter = await buildLodgePolicyExceptionReservationCounter({
        lodgeId: LODGE,
        from: parseDateOnly("2026-07-01"),
        toExclusive: parseDateOnly("2026-07-04"),
        nights: [parseDateOnly("2026-07-01")],
        db: {} as never,
      });
      expect(counter(parseDateOnly("2026-07-01"))).toBe(0);
    });
  });
});
