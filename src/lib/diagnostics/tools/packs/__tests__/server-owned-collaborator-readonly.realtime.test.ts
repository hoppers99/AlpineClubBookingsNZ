/**
 * AID-8 F3 — the escape census, extended past the pack modules to the EXTERNAL
 * `@/lib/` collaborators a `server_owned` evidence read drives.
 *
 * WHAT WAS ALREADY COVERED, AND THE HOLE. `read-only-transaction.test.ts` runs a
 * tree-wide SOURCE census asserting that no module under `tools/packs/` names the
 * global `prisma` client. That is a real guard, but it stops at the pack boundary:
 * a `server_owned` read hands its transaction client to collaborators that live
 * OUTSIDE `packs/` — the capacity engine (`@/lib/capacity`), which walks the whole
 * lodge's occupancy — and those modules legitimately name the global client on their
 * OTHER (write) paths, so a "names no prisma" source census cannot be applied to them
 * without becoming vacuous. Their read-only-ness on the diagnostics path rests on
 * two things a source census cannot see: that the pack threads `tx` into them, and
 * that they in turn thread it onward rather than reaching for the global singleton.
 * `read-only-transaction.ts` says so explicitly (the "THAT RULE IS PINNED AT THE
 * SOURCE … cannot pin it" paragraph).
 *
 * WHY A RUNTIME REGRESSION AND NOT A WIDER CENSUS (AID-8 F3 decision). A source
 * census over the collaborators is the option that "trivially passes or trivially
 * fails" — they DO name `prisma` for their write callers, so the census would either
 * be neutered to nothing or be red forever. So this is the other option the finding
 * offered: run the real read against a WRITE-REFUSING transaction double and a global
 * `prisma` whose write methods RECORD-AND-THROW, and assert nothing wrote and nothing
 * reached the global client to write. The `SET TRANSACTION READ ONLY` backstop the
 * realdb seam test proves catches a write issued THROUGH `tx`; it cannot catch a
 * collaborator that bypasses `tx` for the GLOBAL client, which is precisely the edge
 * this covers.
 *
 * NON-VACUITY IS ASSERTED, NOT ASSUMED. The double serves a valid booking so the
 * capacity read runs to completion, and the test asserts the double was asked for a
 * read that ONLY the external collaborator makes (`clubModuleSettings.findUnique`,
 * reached inside `getLodgeCapacity`, which the pack's own read body never calls) — so
 * a green result means "the real capacity engine ran and issued no escaping write",
 * never "the read short-circuited before reaching it".
 *
 * COVERAGE BOUND, STATED HONESTLY. The rigorous, mutation-verified anchor is the
 * booking-capacity read and its `@/lib/capacity` collaborator graph (`checkCapacity`
 * → `getLodgeCapacity` → `computeNightOccupancy`, plus the dynamic `@/lib/lodge-
 * settings` import). The block-state read is swept for write escapes too, to whatever
 * depth its heavier collaborator graph reaches on this fixture. Entries in the
 * finance and support packs keep the packs-only source census plus the server-side
 * `25006` backstop; extending this runtime sweep to them is a follow-up, not a claim
 * this file makes.
 *
 * MUTATION TRANSCRIPT (AID-8 F3). Planting `await prisma.booking.updateMany({ where:
 * {}, data: {} });` as the first statement of `checkCapacity` in `src/lib/capacity.ts`
 * — a global-client write on a covered collaborator path — makes "no global-client
 * write escaped" red (the recorder logs `booking.updateMany`). Reverting restores
 * green.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Everything the `vi.mock` factory closes over must be created in a hoisted block,
// because `vi.mock` is hoisted above ordinary top-level declarations.
const harness = vi.hoisted(() => {
  const globalWrites: Array<{ model: string; method: string }> = [];
  const txWrites: Array<{ model: string; method: string }> = [];
  const readsServed = new Set<string>();

  /** Prisma delegate methods that MUTATE. Anything here is a write escape. */
  const WRITE_METHODS = new Set([
    "create",
    "createMany",
    "createManyAndReturn",
    "update",
    "updateMany",
    "updateManyAndReturn",
    "upsert",
    "delete",
    "deleteMany",
  ]);

  /** The read a delegate method returns when the seed does not override it. */
  function defaultReadResult(method: string): unknown {
    if (method === "count") return 0;
    if (method === "aggregate") return {};
    if (
      method === "findMany" ||
      method === "findManyAndReturn" ||
      method === "groupBy"
    ) {
      return [];
    }
    // findUnique / findFirst / findUniqueOrThrow / findFirstOrThrow and anything else
    return null;
  }

  type Seed = Record<string, Record<string, unknown>>;

  /**
   * A read-permissive, write-refusing Prisma client double. Model write methods and
   * the unsafe raw executors record into `writes` and throw; read methods resolve a
   * seeded value or a benign default; the two seam control statements (`$executeRaw`
   * tagged templates) resolve without recording anything.
   */
  function makeClientDouble(opts: {
    label: "tx" | "global";
    writes: Array<{ model: string; method: string }>;
    seed: Seed;
    runTransaction?: (cb: (tx: unknown) => unknown) => unknown;
  }): unknown {
    return new Proxy(
      {},
      {
        get(_target, clientProp) {
          if (typeof clientProp !== "string") return undefined;
          // A promise unwrap probe — the client is not a thenable.
          if (clientProp === "then") return undefined;

          if (clientProp === "$transaction" && opts.runTransaction) {
            return (cb: (tx: unknown) => unknown) => opts.runTransaction!(cb);
          }
          // The seam's own control statements plus any tagged-template read.
          if (clientProp === "$executeRaw" || clientProp === "$queryRaw") {
            return async () => 0;
          }
          // Raw executors that CAN write: refused.
          if (
            clientProp === "$executeRawUnsafe" ||
            clientProp === "$queryRawUnsafe"
          ) {
            return async () => {
              opts.writes.push({ model: "$raw", method: clientProp });
              throw new Error(`WRITE ESCAPE (${opts.label}): ${clientProp}`);
            };
          }

          const model = clientProp;
          return new Proxy(
            {},
            {
              get(_m, method) {
                if (typeof method !== "string") return undefined;
                if (WRITE_METHODS.has(method)) {
                  return async () => {
                    opts.writes.push({ model, method });
                    throw new Error(
                      `WRITE ESCAPE (${opts.label}): ${model}.${method}`,
                    );
                  };
                }
                return async () => {
                  readsServed.add(`${model}.${method}`);
                  const seeded = opts.seed[model]?.[method];
                  if (seeded !== undefined) return seeded;
                  return defaultReadResult(method);
                };
              },
            },
          );
        },
      },
    );
  }

  const BOOKING_ID = "11111111-1111-4111-8111-111111111111";
  const LODGE_ID = "22222222-2222-4222-8222-222222222222";

  /**
   * Enough of a live booking that `readBookingCapacity` clears its guards and calls
   * the real `checkCapacity(...tx)`: a two-night span, no guests (so no zero-night
   * guard), and the exact columns the entry selects.
   */
  const CAPACITY_BOOKING = {
    id: BOOKING_ID,
    lodgeId: LODGE_ID,
    status: "CONFIRMED",
    checkIn: new Date("2026-07-01T00:00:00.000Z"),
    checkOut: new Date("2026-07-03T00:00:00.000Z"),
    deletedAt: null,
    wholeLodgeHold: false,
    adminCapacityHoldAt: null,
    originBookingRequest: null,
    capacityOverriddenAt: null,
  };

  // The tx double seed: the booking the read looks up, and a benign module-settings
  // row so the real `getLodgeCapacity` resolves cleanly.
  const TX_SEED: Seed = {
    booking: { findUnique: CAPACITY_BOOKING },
    bookingGuest: { findMany: [] },
    clubModuleSettings: { findUnique: {} },
    lodgeSettings: { findUnique: null },
  };

  const txDouble = () =>
    makeClientDouble({ label: "tx", writes: txWrites, seed: TX_SEED });

  // The global client should never be asked to WRITE on this path (everything is
  // threaded through tx). Reads are permitted (a declared exemption may read the
  // global client). Its ONLY sanctioned use here is the seam's `$transaction`.
  const prisma = makeClientDouble({
    label: "global",
    writes: globalWrites,
    seed: {},
    runTransaction: (cb) => cb(txDouble()),
  });

  return { globalWrites, txWrites, readsServed, prisma, BOOKING_ID };
});

vi.mock("@/lib/prisma", () => ({ prisma: harness.prisma }));

// Imported AFTER the mock is registered.
import {
  readBookingBlockStateEvidence,
  readBookingCapacityEvidence,
} from "../booking-evidence";

beforeEach(() => {
  harness.globalWrites.length = 0;
  harness.txWrites.length = 0;
  harness.readsServed.clear();
});

describe("server_owned collaborators issue no write escapes (AID-8 F3)", () => {
  it("drives the REAL capacity engine and no write reaches tx or the global client", async () => {
    // The read may resolve or reject on the degenerate empty occupancy — either is
    // acceptable. What is NOT acceptable is a write, so only writes fail the test.
    await readBookingCapacityEvidence({ bookingId: harness.BOOKING_ID }).catch(
      () => {
        /* a data-shape rejection is fine; a WRITE-escape rejection is asserted below */
      },
    );

    // THE PROPERTY: no collaborator wrote through the injected tx, and none bypassed
    // it to write through the global client. (The F3 mutation probe — a global
    // `prisma.booking.updateMany` in `checkCapacity` — trips the second assertion.)
    expect(harness.txWrites, "a write escaped through the transaction client").toEqual(
      [],
    );
    expect(
      harness.globalWrites,
      "a collaborator bypassed tx and wrote through the global prisma client",
    ).toEqual([]);

    // NON-VACUITY: the real external collaborator actually ran. `clubModuleSettings`
    // is read only inside `getLodgeCapacity`, which the pack's own read body never
    // calls — so seeing this read proves `checkCapacity` was reached, not
    // short-circuited.
    expect(
      harness.readsServed.has("clubModuleSettings.findUnique"),
      "the real @/lib/capacity collaborator graph was not reached — the sweep would be vacuous",
    ).toBe(true);
  });

  it("sweeps the block-state read's collaborator graph for write escapes too", async () => {
    // A heavier graph (policy evaluators, conflict scan, edit policy) reached to
    // whatever depth this fixture allows. Bounded, best-effort coverage: only a
    // write fails, a data-shape rejection does not.
    await readBookingBlockStateEvidence({ bookingId: harness.BOOKING_ID }).catch(
      () => {
        /* data-shape rejection tolerated */
      },
    );

    expect(harness.txWrites, "a write escaped through the transaction client").toEqual(
      [],
    );
    expect(
      harness.globalWrites,
      "a collaborator bypassed tx and wrote through the global prisma client",
    ).toEqual([]);
  });
});
