/**
 * What a P2002 really looks like under Prisma 7 + `@prisma/adapter-pg` (#2412),
 * and the two things that read it: the join-code collision retry and the
 * login-email backstop.
 *
 * The fixtures are live captures — see `helpers/p2002-fixtures.ts` for how and
 * when they were taken, and for the finding they pin down.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

import { describeUniqueConstraintTarget } from "@/lib/prisma-errors";
import { isLoginEmailUniqueConflict } from "@/lib/member-email";
import {
  googleSubCollisionError,
  joinCodeCollisionError,
  loginEmailCollisionError,
  organiserBookingCollisionError,
  unidentifiableUniqueCollisionError,
} from "@/lib/__tests__/helpers";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    booking: { findUnique: vi.fn() },
    groupBooking: { create: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { createGroupBooking } from "@/lib/group-booking";

describe("adapter-pg P2002 shape (captured live, PostgreSQL 16 + Prisma 7.9.0)", () => {
  it("never populates meta.target, whatever kind of index fired", () => {
    for (const build of [
      joinCodeCollisionError,
      organiserBookingCollisionError,
      loginEmailCollisionError,
      googleSubCollisionError,
    ]) {
      expect(build().meta).not.toHaveProperty("target");
    }
  });

  it("names the colliding column for a schema-level @unique, quoting and all", () => {
    expect(describeUniqueConstraintTarget(joinCodeCollisionError())).toBe(
      "joincode",
    );
    expect(
      describeUniqueConstraintTarget(organiserBookingCollisionError()),
    ).toBe("organiserbookingid");
  });

  it("names the colliding column for a raw partial index too", () => {
    // Member_email_login_unique is hand-written SQL, not a schema `@unique`,
    // and it still reports its COLUMN rather than its index name.
    expect(describeUniqueConstraintTarget(loginEmailCollisionError())).toBe(
      "email",
    );
  });
});

describe("describeUniqueConstraintTarget fallbacks", () => {
  it("prefers meta.target when a non-adapter stack populates it", () => {
    // The message says the opposite, so this fails if the branch is dropped or
    // loses its precedence.
    const error = Object.assign(
      new Error("Unique constraint failed on the fields: (`googleSub`)"),
      { code: "P2002", meta: { target: ["email"] } },
    );
    expect(describeUniqueConstraintTarget(error)).toBe("email");
  });

  it("accepts meta.target as a bare constraint-name string", () => {
    const error = Object.assign(new Error("boom"), {
      code: "P2002",
      meta: { target: "Member_email_login_unique" },
    });
    expect(describeUniqueConstraintTarget(error)).toBe(
      "member_email_login_unique",
    );
  });

  it("joins a composite field list", () => {
    const error = Object.assign(new Error("boom"), {
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: { constraint: { fields: ['"memberId"', '"seasonYear"'] } },
        },
      },
    });
    expect(describeUniqueConstraintTarget(error)).toBe("memberid seasonyear");
  });

  it("reads a constraint index name when the adapter reports one", () => {
    const error = Object.assign(new Error("boom"), {
      code: "P2002",
      meta: {
        driverAdapterError: {
          cause: { constraint: { index: "Member_email_login_unique" } },
        },
      },
    });
    expect(describeUniqueConstraintTarget(error)).toBe(
      "member_email_login_unique",
    );
  });

  it("falls back to the message when Postgres withholds the Key (…) detail", () => {
    // With no `detail` on the driver error, adapter-pg leaves `constraint`
    // undefined and only the rendered sentence is left. Wrapped in the real
    // invocation preamble, so a match anchored at the start would miss it.
    const error = Object.assign(
      new Error(
        [
          "",
          "Invalid `prisma.member.update()` invocation in",
          "/app/src/lib/admin-member-detail-service.ts:1278:44",
          "",
          '→ 1278   where: { id: "m1" },',
          "Unique constraint failed on the fields: (`email`)",
        ].join("\n"),
      ),
      { code: "P2002", meta: { driverAdapterError: { cause: {} } } },
    );
    expect(describeUniqueConstraintTarget(error)).toBe("email");
  });

  it("reads a `constraint:` index name from the message", () => {
    const error = Object.assign(
      new Error(
        "Unique constraint failed on the constraint: `Member_email_login_unique`",
      ),
      { code: "P2002" },
    );
    expect(describeUniqueConstraintTarget(error)).toBe(
      "member_email_login_unique",
    );
  });

  it("returns null when the error names nothing identifiable", () => {
    expect(
      describeUniqueConstraintTarget(unidentifiableUniqueCollisionError()),
    ).toBeNull();
    expect(describeUniqueConstraintTarget(null)).toBeNull();
    expect(describeUniqueConstraintTarget("not an error")).toBeNull();
  });
});

describe("isLoginEmailUniqueConflict against the live shapes", () => {
  it("recognises the raw partial index the login invariant rests on", () => {
    expect(isLoginEmailUniqueConflict(loginEmailCollisionError())).toBe(true);
    expect(isLoginEmailUniqueConflict(loginEmailCollisionError("update"))).toBe(
      true,
    );
  });

  it("does not blame the email for another column", () => {
    expect(isLoginEmailUniqueConflict(googleSubCollisionError())).toBe(false);
  });

  it("still owns a P2002 that names nothing", () => {
    expect(
      isLoginEmailUniqueConflict(unidentifiableUniqueCollisionError()),
    ).toBe(true);
  });

  it("ignores errors that are not P2002 at all", () => {
    expect(isLoginEmailUniqueConflict(new Error("email"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The join-code retry the shape question actually broke
// ---------------------------------------------------------------------------

describe("createGroupBooking join-code collision retry", () => {
  const organiserBooking = {
    id: "b1",
    memberId: "m1",
    status: "CONFIRMED",
    deletedAt: null,
    parentBookingId: null,
    groupBookingAsOrganiser: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.booking.findUnique).mockResolvedValue(
      organiserBooking as never,
    );
  });

  const input = {
    organiserBookingId: "b1",
    paymentMode: "EACH_PAYS_OWN" as const,
  };

  const attemptedCodes = () =>
    vi
      .mocked(prisma.groupBooking.create)
      .mock.calls.map(
        (call) => (call[0] as unknown as { data: { joinCode: string } }).data.joinCode,
      );

  it("regenerates the code and retries on a real joinCode collision", async () => {
    vi.mocked(prisma.groupBooking.create)
      .mockRejectedValueOnce(joinCodeCollisionError())
      .mockRejectedValueOnce(joinCodeCollisionError())
      .mockResolvedValueOnce({ id: "g1", joinCode: "ABCDEFGH" } as never);

    await expect(createGroupBooking(input, "m1")).resolves.toMatchObject({
      id: "g1",
    });
    expect(prisma.groupBooking.create).toHaveBeenCalledTimes(3);
    // Each attempt used a freshly generated code, not the rejected one.
    expect(new Set(attemptedCodes()).size).toBe(3);
  });

  it("reports code exhaustion, not 'already has a group', after the budget", async () => {
    vi.mocked(prisma.groupBooking.create).mockRejectedValue(
      joinCodeCollisionError(),
    );

    await expect(createGroupBooking(input, "m1")).rejects.toMatchObject({
      status: 500,
      message: "Could not generate a unique join code, please try again",
    });
    expect(prisma.groupBooking.create).toHaveBeenCalledTimes(5);
  });

  it("does not retry an organiserBookingId collision — that is a real conflict", async () => {
    vi.mocked(prisma.groupBooking.create).mockRejectedValue(
      organiserBookingCollisionError(),
    );

    await expect(createGroupBooking(input, "m1")).rejects.toMatchObject({
      status: 409,
      message: "This booking already has a group",
    });
    expect(prisma.groupBooking.create).toHaveBeenCalledTimes(1);
  });

  it("does not retry a P2002 that names nothing identifiable", async () => {
    vi.mocked(prisma.groupBooking.create).mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("boom", {
        code: "P2002",
        clientVersion: "7.9.0",
      }),
    );

    await expect(createGroupBooking(input, "m1")).rejects.toMatchObject({
      status: 409,
      message: "This booking already has a group",
    });
    expect(prisma.groupBooking.create).toHaveBeenCalledTimes(1);
  });
});
