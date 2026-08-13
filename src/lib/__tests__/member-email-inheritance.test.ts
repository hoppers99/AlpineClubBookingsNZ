/**
 * `validateInheritEmailSource` — the club's CONTACT OF RECORD rule, as a unit.
 *
 * It had no direct test: every assertion on it ran through a write route, which
 * meant the individual clauses were only ever exercised in whatever combination
 * that route happened to produce. #2282 makes that gap load-bearing. The issue
 * removes the ADULT requirement from RECORDING parentage — a 16 or 17 year old
 * can genuinely be a parent — on the explicit understanding that every
 * RESPONSIBILITY function keeps its own adult gate, and this function is the
 * most important of them: it decides whose inbox a dependant's club mail lands
 * in.
 *
 * Mutation probes, one per clause, each failing a different test below:
 *  - delete `ageTier !== "ADULT"` → "refuses a young parent as the source" passes
 *    a minor as the family's contact of record;
 *  - delete the `inheritEmailFromId` clause → "refuses a chaining source" fails,
 *    and stored inheritance stops being flat;
 *  - delete the `archivedAt` clause → "refuses an archived source" fails;
 *  - delete the `cancelledAt` clause → "refuses a source who has left the club"
 *    fails, and a member who resigned can be made a family's contact of record;
 *  - delete the placeholder clause → "refuses a placeholder address" fails, and
 *    the family silently stops receiving anything;
 *  - delete the self-reference clause → "refuses the member themselves" fails.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: { member: { findUnique: vi.fn() } } }));

import { validateInheritEmailSource } from "@/lib/member-email-inheritance";

type Row = {
  id: string;
  ageTier: string;
  email: string;
  inheritEmailFromId: string | null;
  inheritEmailChoiceId: string | null;
  archivedAt: Date | null;
  cancelledAt: Date | null;
};

function db(rows: Array<Partial<Row> & { id: string }>) {
  const byId = new Map<string, Row>(
    rows.map((row) => [
      row.id,
      {
        ageTier: "ADULT",
        email: `${row.id}@example.org`,
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
        archivedAt: null,
        cancelledAt: null,
        ...row,
      } as Row,
    ]),
  );
  return {
    member: {
      async findUnique({ where }: { where: { id: string } }) {
        return byId.get(where.id) ?? null;
      },
    },
  } as unknown as Parameters<typeof validateInheritEmailSource>[1];
}

describe("validateInheritEmailSource", () => {
  it("accepts an active adult with a real address who inherits from nobody", () => {
    return expect(
      validateInheritEmailSource({ inheritEmailFromId: "gran" }, db([{ id: "gran" }])),
    ).resolves.toEqual({ ok: true });
  });

  // #2282: THE gate the whole issue rests on. Recording a 16-year-old as a
  // parent is a fact about the family; being the club's contact of record for
  // someone else's notifications is a responsibility, and it stays adult-only.
  it("refuses a young parent as the source (#2282)", async () => {
    await expect(
      validateInheritEmailSource(
        { inheritEmailFromId: "teen-parent" },
        db([{ id: "teen-parent", ageTier: "YOUTH", email: "teen@example.org" }]),
      ),
    ).resolves.toEqual({
      ok: false,
      status: 422,
      error: "Email inheritance must point to an adult member",
    });
  });

  it("refuses every non-adult tier, not just YOUTH", async () => {
    for (const ageTier of ["INFANT", "CHILD", "YOUTH", "NOT_APPLICABLE"]) {
      const result = await validateInheritEmailSource(
        { inheritEmailFromId: "src" },
        db([{ id: "src", ageTier }]),
      );
      expect({ ageTier, ok: result.ok }).toEqual({ ageTier, ok: false });
    }
  });

  it("refuses a chaining source, so stored inheritance stays flat", () => {
    return expect(
      validateInheritEmailSource(
        { inheritEmailFromId: "middle" },
        db([{ id: "middle", inheritEmailFromId: "gran" }, { id: "gran" }]),
      ),
    ).resolves.toMatchObject({ ok: false, status: 422 });
  });

  // #2716 review. `archivedAt` was tested and `cancelledAt` was not, although
  // they are separate states here: cancellation deactivates and de-logs a member
  // while leaving `archivedAt` null. The member edit page's hand-picked source
  // has no other lifecycle gate behind it, so a member who had left the club
  // could be made somebody's contact of record.
  it("refuses a source who has left the club", () => {
    return expect(
      validateInheritEmailSource(
        { inheritEmailFromId: "left" },
        db([{ id: "left", cancelledAt: new Date("2026-01-01") }]),
      ),
    ).resolves.toMatchObject({ ok: false, status: 422 });
  });

  it("refuses an archived source", () => {
    return expect(
      validateInheritEmailSource(
        { inheritEmailFromId: "gone" },
        db([{ id: "gone", archivedAt: new Date("2026-01-01") }]),
      ),
    ).resolves.toMatchObject({ ok: false, status: 422 });
  });

  it("refuses a placeholder address, which sendEmail would silently drop", () => {
    return expect(
      validateInheritEmailSource(
        { inheritEmailFromId: "walkin" },
        db([{ id: "walkin", email: "walk-in-1@no-email.invalid" }]),
      ),
    ).resolves.toMatchObject({ ok: false, status: 422 });
  });

  it("refuses the member themselves", () => {
    return expect(
      validateInheritEmailSource(
        { inheritEmailFromId: "me", memberId: "me" },
        db([{ id: "me" }]),
      ),
    ).resolves.toMatchObject({ ok: false, status: 422 });
  });

  it("404s on a source that does not exist", () => {
    return expect(
      validateInheritEmailSource({ inheritEmailFromId: "ghost" }, db([])),
    ).resolves.toMatchObject({ ok: false, status: 404 });
  });
});
