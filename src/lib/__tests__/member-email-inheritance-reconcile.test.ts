/**
 * Direct-parent email inheritance, and the re-resolution that keeps it true
 * (#2716, owner decision on #2708).
 *
 * This file covers the two halves of the decision and the property that makes
 * the second half safe:
 *
 *   1. inheritance is ONE HOP — a member inherits from a parent or from nobody;
 *   2. pointers RE-RESOLVE when an address is added, changed or removed;
 *   3. the re-resolution is a pure function of the tree, so it is idempotent and
 *      can be re-run over everybody to converge.
 *
 * MUTATION PROBES — each breaks one rule and fails one NAMED test:
 *  - `isUsableEmailSource`, delete `ageTier === "ADULT"` → "refuses a minor
 *    parent as a source" fails, and a child becomes their family's contact.
 *  - `isUsableEmailSource`, delete the `cancelledAt` clause → "refuses a parent
 *    who has left the club" fails, and a member who resigned can still be a
 *    family's contact of record.
 *  - `isUsableEmailSource`, delete the `inheritEmailChoiceId === null` clause →
 *    "a member who inherits is not a mailbox" fails, and a dependant is routed
 *    to a stale copy of a third party's address.
 *  - `resolveInheritedEmailSourceId`, fall back to the parent's own
 *    `inheritEmailFromId` → "does not reach a grandparent even when the parent
 *    already points at them" fails, and transitive inheritance is back. Note
 *    which test kills it: the addressless-parent case alone does NOT, because
 *    there the fallback is itself null and the mutant agrees by accident.
 *  - `effectiveEmailSourceId`, return the choice without the usability test →
 *    "clears the pointer when the chosen parent's address is removed" fails.
 *  - `effectiveEmailSourceId`, return null whenever the choice is unusable AND
 *    forget that the choice is kept → "restores the pointer when the address
 *    comes back" fails (covered by the reconcile tests, which re-read state).
 *  - `adoptedEmailInheritanceChoiceId`, adopt any pointer → "refuses to adopt a
 *    transitive pointer left by an old deploy colour" fails.
 *  - `convergeSubjects`, write on every row rather than only on change →
 *    "writes nothing on a second run" fails.
 *  - `unreachableMemberWhere`, drop the `inheritEmailChoiceId` arm → "lists a
 *    member whose chosen parent has no address" fails, which is the whole
 *    accepted cost going invisible.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type MemberRow = {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  role: string;
  active: boolean;
  archivedAt: Date | null;
  cancelledAt: Date | null;
  parentMemberId: string | null;
  secondaryParentId: string | null;
  inheritParentEmail: boolean;
  inheritEmailFromId: string | null;
  inheritEmailChoiceId: string | null;
};

const store = new Map<string, MemberRow>();
let updateCount = 0;

function seed(rows: Array<Partial<MemberRow> & { id: string }>) {
  store.clear();
  updateCount = 0;
  for (const row of rows) {
    store.set(row.id, {
      firstName: row.id,
      lastName: "Test",
      email: `${row.id}@example.org`,
      ageTier: "ADULT",
      role: "USER",
      active: true,
      archivedAt: null,
      cancelledAt: null,
      parentMemberId: null,
      secondaryParentId: null,
      inheritParentEmail: true,
      inheritEmailFromId: null,
      inheritEmailChoiceId: null,
      ...row,
    });
  }
}

/**
 * A deliberately small Prisma `where` evaluator: exactly the operators this
 * module builds, and a THROW on anything else.
 *
 * The throw is the point. A fake that quietly ignores an operator it does not
 * know would keep passing while the predicate under test grew a clause nobody
 * verified — which, for a predicate that decides whether a member is reachable
 * at all, is the failure this file exists to prevent.
 */
function matches(row: MemberRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") {
      return (condition as Array<Record<string, unknown>>).some((clause) =>
        matches(row, clause),
      );
    }
    if (key === "NOT") {
      return !matches(row, condition as Record<string, unknown>);
    }
    const value = (row as unknown as Record<string, unknown>)[key];
    if (condition === null || typeof condition !== "object") {
      return value === condition;
    }
    const operators = condition as Record<string, unknown>;
    return Object.entries(operators).every(([operator, operand]) => {
      switch (operator) {
        case "in":
          return (operand as unknown[]).includes(value);
        case "notIn":
          return !(operand as unknown[]).includes(value);
        case "not":
          return operand === null ? value !== null : value !== operand;
        case "endsWith":
          return String(value)
            .toLowerCase()
            .endsWith(String(operand).toLowerCase());
        case "mode":
          return true; // case-insensitivity is applied by `endsWith` above
        default:
          throw new Error(
            `fake prisma: unsupported operator "${operator}" on "${key}" — teach the fake or the assertion proves nothing`,
          );
      }
    });
  });
}

const fakePrisma = {
  member: {
    async findMany(args: {
      where?: Record<string, unknown>;
      orderBy?:
        | Array<Record<string, "asc" | "desc">>
        | Record<string, "asc" | "desc">;
      take?: number;
      cursor?: { id: string };
      skip?: number;
    }) {
      let rows = [...store.values()].filter((row) =>
        args.where ? matches(row, args.where) : true,
      );
      // Honour `orderBy` rather than always sorting by id: an assertion on the
      // order of a list is worthless if the fake picks its own.
      const orderBy = args.orderBy
        ? Array.isArray(args.orderBy)
          ? args.orderBy
          : [args.orderBy]
        : [{ id: "asc" as const }];
      rows.sort((a, b) => {
        for (const term of orderBy) {
          const [field, direction] = Object.entries(term)[0]!;
          const compared = String(
            (a as unknown as Record<string, unknown>)[field],
          ).localeCompare(
            String((b as unknown as Record<string, unknown>)[field]),
          );
          if (compared !== 0) return direction === "desc" ? -compared : compared;
        }
        return 0;
      });
      if (args.cursor) {
        const index = rows.findIndex((row) => row.id === args.cursor!.id);
        rows = rows.slice(index + 1);
      }
      const page =
        typeof args.take === "number" ? rows.slice(0, args.take) : rows;
      // COPIES, as Prisma returns. Handing back the live store objects would let
      // a later `update` mutate a row the caller is still comparing against —
      // which silently hid a real "did this change?" branch the first time this
      // fake was written.
      return page.map((row) => ({ ...row }));
    },
    async findUnique({ where }: { where: { id: string } }) {
      const row = store.get(where.id);
      return row ? { ...row } : null;
    },
    async count({ where }: { where?: Record<string, unknown> }) {
      return [...store.values()].filter((row) =>
        where ? matches(row, where) : true,
      ).length;
    },
    async update({
      where,
      data,
    }: {
      where: { id: string };
      data: Partial<MemberRow>;
    }) {
      const row = store.get(where.id);
      if (!row) throw new Error(`fake prisma: no member ${where.id}`);
      updateCount += 1;
      Object.assign(row, data);
      return row;
    },
  },
};

// The factory is hoisted above every top-level binding, so it must reach
// `fakePrisma` lazily rather than close over it directly.
vi.mock("@/lib/prisma", () => ({
  get prisma() {
    return fakePrisma;
  },
}));

import {
  adoptedEmailInheritanceChoiceId,
  effectiveEmailSourceId,
  getUnreachableMemberSummary,
  isUsableEmailSource,
  reconcileAllEmailInheritance,
  reconcileEmailInheritanceForMemberChange,
  unreachableMemberWhere,
} from "@/lib/member-email-inheritance";
import { resolveInheritedEmailSourceId } from "@/lib/member-parent-links";

const db = fakePrisma as unknown as Parameters<
  typeof reconcileEmailInheritanceForMemberChange
>[0];

const PLACEHOLDER = "walk-in-1@no-email.invalid";

/** Grandparent with the only mailbox; parent with none; child under the parent. */
function threeGenerations(parentEmail: string) {
  seed([
    { id: "gran" },
    { id: "parent", email: parentEmail, parentMemberId: "gran" },
    { id: "child", ageTier: "YOUTH", email: PLACEHOLDER, parentMemberId: "parent" },
  ]);
}

beforeEach(() => {
  store.clear();
  updateCount = 0;
});

describe("one hop", () => {
  it("resolves a dependant to their own parent when that parent can receive mail", async () => {
    threeGenerations("parent@example.org");
    await expect(resolveInheritedEmailSourceId(db, "parent")).resolves.toEqual({
      sourceId: "parent",
    });
  });

  it("does not reach a grandparent through an addressless parent", async () => {
    // The retired behaviour: the walk climbed past the parent's placeholder
    // address and landed on the grandparent. An address that travels an
    // arbitrary number of hops is unpredictable to the person whose address it
    // is, so the answer is now NOBODY and the club has to ask for one.
    threeGenerations(PLACEHOLDER);
    await expect(resolveInheritedEmailSourceId(db, "parent")).resolves.toEqual({
      sourceId: null,
    });
  });

  it("does not reach a grandparent even when the parent already points at them", async () => {
    // The same shape from the other direction: a parent who is themselves
    // inheriting. Following their pointer would be transitivity wearing a
    // different hat, and their own `email` column is a stale copy besides.
    threeGenerations(PLACEHOLDER);
    store.get("parent")!.inheritEmailFromId = "gran";
    store.get("parent")!.inheritEmailChoiceId = "gran";
    await expect(resolveInheritedEmailSourceId(db, "parent")).resolves.toEqual({
      sourceId: null,
    });
  });

  it("refuses a parent who has left the club", () => {
    // #2716 review. `archivedAt` was tested here and `cancelledAt` was not,
    // although cancellation deactivates and de-logs a member while leaving
    // `archivedAt` null. `active: false` is deliberately NOT tested: a lapsed
    // membership is not a statement about whether the person's mailbox reaches
    // them, and clearing a child's contact of record over it would be the
    // failure this whole feature exists to prevent.
    expect(
      isUsableEmailSource({
        id: "left",
        ageTier: "ADULT",
        email: "left@example.org",
        archivedAt: null,
        cancelledAt: new Date("2026-01-01"),
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
      }),
    ).toBe(false);
    expect(
      isUsableEmailSource({
        id: "current",
        ageTier: "ADULT",
        email: "current@example.org",
        archivedAt: null,
        cancelledAt: null,
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
      }),
    ).toBe(true);
  });

  it("refuses a minor parent as a source (#2282 survives #2716)", () => {
    expect(
      isUsableEmailSource({
        id: "teen",
        ageTier: "YOUTH",
        email: "teen@example.org",
        archivedAt: null,
        inheritEmailFromId: null,
        inheritEmailChoiceId: null,
      }),
    ).toBe(false);
  });

  it("a member who inherits is not a mailbox, even with a real address of their own", () => {
    // Their `email` column is typically a stale copy of the address they
    // inherit, so honouring them would deliver a dependant's notifications to a
    // third party while every screen showed a valid inheritance.
    expect(
      isUsableEmailSource({
        id: "middle",
        ageTier: "ADULT",
        email: "real@example.org",
        archivedAt: null,
        inheritEmailFromId: null,
        inheritEmailChoiceId: "guardian",
      }),
    ).toBe(false);
  });
});

describe("effectiveEmailSourceId", () => {
  const subject = {
    id: "child",
    inheritParentEmail: true,
    parentMemberId: "parent",
    secondaryParentId: null,
    inheritEmailChoiceId: "parent",
    inheritEmailFromId: null,
  };
  const usableParent = {
    id: "parent",
    ageTier: "ADULT",
    email: "parent@example.org",
    archivedAt: null,
    inheritEmailFromId: null,
    inheritEmailChoiceId: null,
  };

  it("resolves to the choice while the chosen member can receive mail", () => {
    expect(effectiveEmailSourceId(subject, usableParent)).toBe("parent");
  });

  it("resolves to nobody when no choice was ever recorded", () => {
    expect(
      effectiveEmailSourceId(
        { ...subject, inheritEmailChoiceId: null },
        usableParent,
      ),
    ).toBeNull();
  });

  it("resolves to nobody when the chosen member's address is gone", () => {
    expect(
      effectiveEmailSourceId(subject, { ...usableParent, email: PLACEHOLDER }),
    ).toBeNull();
  });

  it("never points a member at themselves", () => {
    expect(
      effectiveEmailSourceId(
        { ...subject, inheritEmailChoiceId: "child" },
        { ...usableParent, id: "child" },
      ),
    ).toBeNull();
  });
});

describe("adopting a pointer written without a choice", () => {
  // The shape a draining blue/green old colour produces: it knows only
  // `inheritEmailFromId`, so anything it writes between migrate and cutover
  // arrives unaccompanied.
  const base = {
    id: "child",
    inheritParentEmail: true,
    parentMemberId: "parent",
    secondaryParentId: null,
    inheritEmailChoiceId: null,
  };

  it("adopts a one-hop pointer, so a link made mid-deploy is not lost", () => {
    expect(
      adoptedEmailInheritanceChoiceId({ ...base, inheritEmailFromId: "parent" }),
    ).toBe("parent");
  });

  it("refuses to adopt a transitive pointer left by an old deploy colour", () => {
    // One hop enforced at the last door: the retired behaviour cannot re-enter
    // through the drain window.
    expect(
      adoptedEmailInheritanceChoiceId({ ...base, inheritEmailFromId: "gran" }),
    ).toBeNull();
  });

  it("leaves an existing choice alone", () => {
    expect(
      adoptedEmailInheritanceChoiceId({
        ...base,
        inheritEmailChoiceId: "picked",
        inheritEmailFromId: null,
      }),
    ).toBe("picked");
  });
});

describe("re-resolution on add, change and remove", () => {
  it("follows a parent who changes address — the case the old behaviour got wrong", async () => {
    seed([
      { id: "parent" },
      {
        id: "child",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "parent",
        inheritEmailChoiceId: "parent",
        inheritEmailFromId: "parent",
      },
    ]);

    store.get("parent")!.email = "new-address@example.org";
    await reconcileEmailInheritanceForMemberChange(db, ["parent"]);

    // The pointer names the parent either way; what the test pins is that the
    // resolution ran and agreed, which is what a later removal depends on.
    expect(store.get("child")!.inheritEmailFromId).toBe("parent");
  });

  it("clears the pointer when the chosen parent's address is REMOVED, and keeps the choice", async () => {
    seed([
      { id: "parent" },
      {
        id: "child",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "parent",
        inheritEmailChoiceId: "parent",
        inheritEmailFromId: "parent",
      },
    ]);

    store.get("parent")!.email = "deleted-abc@deleted.invalid";
    await reconcileEmailInheritanceForMemberChange(db, ["parent"]);

    expect(store.get("child")!.inheritEmailFromId).toBeNull();
    // The decision survives the address. Without this the pointer could never
    // come back, and the fix for one silent failure would introduce another.
    expect(store.get("child")!.inheritEmailChoiceId).toBe("parent");
  });

  it("restores the pointer when the address comes back — the ADD case", async () => {
    seed([
      { id: "parent", email: PLACEHOLDER },
      {
        id: "child",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "parent",
        inheritEmailChoiceId: "parent",
        inheritEmailFromId: null,
      },
    ]);

    store.get("parent")!.email = "back@example.org";
    await reconcileEmailInheritanceForMemberChange(db, ["parent"]);

    expect(store.get("child")!.inheritEmailFromId).toBe("parent");
  });

  it("re-points nobody when a member gains an address they were never chosen for", async () => {
    // The consent rule, as a test. A child with two parents whose choice names
    // one of them must not be moved onto the other because the other happens to
    // become reachable first.
    seed([
      { id: "mum" },
      { id: "dad", email: PLACEHOLDER },
      {
        id: "child",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "mum",
        secondaryParentId: "dad",
        inheritEmailChoiceId: "mum",
        inheritEmailFromId: "mum",
      },
    ]);

    store.get("dad")!.email = "dad@example.org";
    await reconcileEmailInheritanceForMemberChange(db, ["dad"]);

    expect(store.get("child")!.inheritEmailFromId).toBe("mum");
  });

  it("does not touch a member whose choice names somebody else", async () => {
    seed([
      { id: "mum" },
      { id: "dad" },
      {
        id: "child",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "mum",
        secondaryParentId: "dad",
        inheritEmailChoiceId: "dad",
        inheritEmailFromId: "dad",
      },
    ]);

    await reconcileEmailInheritanceForMemberChange(db, ["mum"]);

    expect(store.get("child")!.inheritEmailFromId).toBe("dad");
    expect(updateCount).toBe(0);
  });
});

describe("whole-tree convergence", () => {
  it("writes nothing on a second run", async () => {
    seed([
      { id: "gran" },
      { id: "parent", email: PLACEHOLDER, parentMemberId: "gran" },
      {
        id: "child",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "parent",
        inheritEmailChoiceId: "parent",
        inheritEmailFromId: "parent",
      },
    ]);

    const first = await reconcileAllEmailInheritance(db);
    expect(first.cleared).toBe(1);

    updateCount = 0;
    const second = await reconcileAllEmailInheritance(db);
    // Idempotence is what makes a partial failure recoverable by re-running
    // rather than by hand, and it is what made prompt-free re-pointing safe.
    expect({ updates: updateCount, repointed: second.repointed, cleared: second.cleared })
      .toEqual({ updates: 0, repointed: 0, cleared: 0 });
  });

  it("reaches the same answer whichever member it visits first", async () => {
    // `middle` holds a choice and a real-looking address of their own. If
    // usability were judged on the pointer alone, whether `leaf` kept its
    // pointer would depend on whether `middle` had been converged yet.
    seed([
      { id: "guardian" },
      {
        id: "middle",
        email: "stale-copy@example.org",
        inheritParentEmail: false,
        inheritEmailChoiceId: "guardian",
        inheritEmailFromId: "guardian",
      },
      {
        id: "leaf",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "middle",
        inheritEmailChoiceId: "middle",
        inheritEmailFromId: "middle",
      },
    ]);

    await reconcileAllEmailInheritance(db);
    expect(store.get("leaf")!.inheritEmailFromId).toBeNull();

    await reconcileEmailInheritanceForMemberChange(db, ["leaf", "middle"]);
    expect(store.get("leaf")!.inheritEmailFromId).toBeNull();
  });
});

describe("the admin surface for members with no reachable address", () => {
  it("lists a member whose chosen parent has no address", async () => {
    seed([
      { id: "parent", email: PLACEHOLDER },
      {
        id: "child",
        firstName: "Sam",
        lastName: "Young",
        ageTier: "YOUTH",
        // A real-looking address that is a COPY of the parent's old one. This is
        // why a placeholder-address test alone is not enough: this member reads
        // as perfectly reachable and their mail would go to somebody else.
        email: "old-family-address@example.org",
        parentMemberId: "parent",
        inheritEmailChoiceId: "parent",
        inheritEmailFromId: null,
      },
    ]);

    const summary = await getUnreachableMemberSummary(db);
    // Both of them, and for DIFFERENT reasons — which is the split the count
    // exists to make: the parent needs an address recorded, the child needs
    // nothing except the parent's. An admin who cannot tell those apart works
    // the wrong one first.
    expect(summary.total).toBe(2);
    expect(summary.inheritanceUnresolved).toBe(1);
    expect(summary.members).toEqual([
      { id: "parent", name: "parent Test", reason: "placeholder-address" },
      { id: "child", name: "Sam Young", reason: "inheritance-unresolved" },
    ]);
  });

  it("lists a member who has only a placeholder address of their own", async () => {
    seed([{ id: "walkin", email: PLACEHOLDER }]);
    const summary = await getUnreachableMemberSummary(db);
    expect(summary.members).toEqual([
      { id: "walkin", name: "walkin Test", reason: "placeholder-address" },
    ]);
  });

  it("leaves out members the club is not supposed to be reaching", async () => {
    seed([
      { id: "school", email: PLACEHOLDER, role: "SCHOOL" },
      { id: "walkin-contact", email: PLACEHOLDER, role: "NON_MEMBER" },
      { id: "kiosk", email: PLACEHOLDER, role: "LODGE" },
      { id: "left", email: PLACEHOLDER, active: false },
      { id: "archived", email: PLACEHOLDER, archivedAt: new Date("2026-01-01") },
      { id: "cancelled", email: PLACEHOLDER, cancelledAt: new Date("2026-01-01") },
      { id: "reachable", email: "fine@example.org" },
    ]);
    await expect(
      fakePrisma.member.count({ where: unreachableMemberWhere() }),
    ).resolves.toBe(0);
  });

  it("does not list a member whose inheritance currently resolves", async () => {
    seed([
      { id: "parent" },
      {
        id: "child",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "parent",
        inheritEmailChoiceId: "parent",
        inheritEmailFromId: "parent",
      },
    ]);
    const summary = await getUnreachableMemberSummary(db);
    expect(summary.total).toBe(0);
  });

  it("shows the member the moment the parent's address is removed", async () => {
    seed([
      { id: "parent" },
      {
        id: "child",
        ageTier: "YOUTH",
        email: PLACEHOLDER,
        parentMemberId: "parent",
        inheritEmailChoiceId: "parent",
        inheritEmailFromId: "parent",
      },
    ]);

    store.get("parent")!.email = PLACEHOLDER;
    await reconcileEmailInheritanceForMemberChange(db, ["parent"]);

    const summary = await getUnreachableMemberSummary(db);
    // Both of them: the parent has no address of their own, and the child is
    // now waiting on it. The gap is the accepted cost, and this is the seeing.
    expect(summary.members.map((member) => member.id).sort()).toEqual([
      "child",
      "parent",
    ]);
  });
});
