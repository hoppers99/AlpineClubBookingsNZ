/**
 * Real P2002 errors, as Prisma 7 + `@prisma/adapter-pg` actually raises them.
 *
 * The four collision fixtures — `joinCode`, `organiserBookingId`, the login-email
 * partial index and `googleSub` — were CAPTURED LIVE on 1 Aug 2026 (#2412) by
 * forcing each collision against a throwaway PostgreSQL 16 container built from
 * this repo's own migration tree, through a client constructed exactly the way
 * `src/lib/prisma.ts` constructs it — `new PrismaClient({ adapter: new PrismaPg(…) })`,
 * client version 7.9.0. They are verbatim: do not "tidy" the escaped double
 * quotes inside `constraint.fields`, that quoting is part of what was measured.
 *
 * The fixtures below them are marked SYNTHETIC where they are: shapes built to
 * probe the parser (an error naming nothing, an adapter detail contradicting the
 * message, a composite constraint) that adapter-pg was not observed emitting.
 * Never read one of those as evidence of what the driver really does.
 *
 * The headline finding, so nobody has to rediscover it a third time:
 *
 * - `meta.target` is NOT populated under the driver adapter. Not for a
 *   schema-level `@unique`, not for a hand-written partial index. Code that
 *   reads only `meta.target` is dead on this stack.
 * - The colliding COLUMNS arrive at `meta.driverAdapterError.cause.constraint.fields`,
 *   quoted exactly as Postgres quoted them: `"joinCode"` keeps its double
 *   quotes, lowercase `email` does not. The index NAME appears only inside
 *   `cause.originalMessage`.
 * - A raw partial index reports its column just like a schema `@unique` does —
 *   there is no observable difference between the two kinds.
 */
import { Prisma } from "@prisma/client";

function livePrismaP2002(message: string, meta: unknown) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code: "P2002",
    clientVersion: "7.9.0",
    meta: meta as Record<string, unknown>,
  });
}

/** Duplicate `GroupBooking.joinCode` — a schema-level `@unique`, camelCase. */
export const joinCodeCollisionError = () =>
  livePrismaP2002(
    '\nInvalid `prisma.groupBooking.create()` invocation:\n\n\nUnique constraint failed on the fields: (`"joinCode"`)',
    {
      modelName: "GroupBooking",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23505",
          originalMessage:
            'duplicate key value violates unique constraint "GroupBooking_joinCode_key"',
          kind: "UniqueConstraintViolation",
          constraint: { fields: ['"joinCode"'] },
        },
      },
    },
  );

/** Duplicate `GroupBooking.organiserBookingId` — the model's other `@unique`. */
export const organiserBookingCollisionError = () =>
  livePrismaP2002(
    '\nInvalid `prisma.groupBooking.create()` invocation:\n\n\nUnique constraint failed on the fields: (`"organiserBookingId"`)',
    {
      modelName: "GroupBooking",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23505",
          originalMessage:
            'duplicate key value violates unique constraint "GroupBooking_organiserBookingId_key"',
          kind: "UniqueConstraintViolation",
          constraint: { fields: ['"organiserBookingId"'] },
        },
      },
    },
  );

/**
 * Duplicate on `Member_email_login_unique` — the RAW PARTIAL index created by
 * hand in a migration (`ON "Member" (email) WHERE "canLogin" = true`), which is
 * what enforces "at most one login-capable member per address".
 */
export const loginEmailCollisionError = (
  operation: "create" | "update" = "create",
) =>
  livePrismaP2002(
    `\nInvalid \`prisma.member.${operation}()\` invocation:\n\n\nUnique constraint failed on the fields: (\`email\`)`,
    {
      modelName: "Member",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23505",
          originalMessage:
            'duplicate key value violates unique constraint "Member_email_login_unique"',
          kind: "UniqueConstraintViolation",
          constraint: { fields: ["email"] },
        },
      },
    },
  );

/** Duplicate `Member.googleSub` — a different unique column on the same model. */
export const googleSubCollisionError = () =>
  livePrismaP2002(
    '\nInvalid `prisma.member.update()` invocation:\n\n\nUnique constraint failed on the fields: (`"googleSub"`)',
    {
      modelName: "Member",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23505",
          originalMessage:
            'duplicate key value violates unique constraint "Member_googleSub_key"',
          kind: "UniqueConstraintViolation",
          constraint: { fields: ['"googleSub"'] },
        },
      },
    },
  );

/**
 * SYNTHETIC. A P2002 carrying nothing identifiable — no adapter detail, and a
 * message with no field list. Adapter-pg was never seen raising this (it always
 * populated `driverAdapterError`); it stands in for the stack changing under us
 * or Postgres withholding the `Key (…)` detail, which is the case the
 * unnamed-collision fallbacks exist for. Assumed, not measured.
 */
export const unidentifiableUniqueCollisionError = () =>
  livePrismaP2002("\nInvalid `prisma.member.create()` invocation:\n\n\nboom", {
    modelName: "Member",
  });

/**
 * SYNTHETIC. Adapter detail and rendered message name DIFFERENT columns, which
 * the real client never does — the message is rendered from the same field list.
 * It exists to pin the precedence: the adapter detail is the measured signal, so
 * a parser that quietly fell back to the message would answer "googlesub" here.
 */
export const contradictoryAdapterAndMessageError = () =>
  livePrismaP2002(
    '\nInvalid `prisma.member.create()` invocation:\n\n\nUnique constraint failed on the fields: (`"googleSub"`)',
    {
      modelName: "Member",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23505",
          originalMessage:
            'duplicate key value violates unique constraint "Member_email_login_unique"',
          kind: "UniqueConstraintViolation",
          constraint: { fields: ["email"] },
        },
      },
    },
  );

/**
 * SYNTHETIC, a matched pair. The same composite collision
 * (`MemberSubscription @@unique([memberId, seasonYear])`) as the adapter reports
 * it (a field ARRAY) and as it survives when only the rendered message is left
 * (a comma-separated list). Both must describe themselves identically, or a
 * caller comparing names gets a different answer depending on whether Postgres
 * happened to send the `Key (…)` detail.
 */
export const compositeCollisionError = (
  shape: "adapter-detail" | "message-only",
) =>
  livePrismaP2002(
    '\nInvalid `prisma.memberSubscription.create()` invocation:\n\n\nUnique constraint failed on the fields: (`"memberId"`,`"seasonYear"`)',
    shape === "message-only"
      ? { modelName: "MemberSubscription" }
      : {
          modelName: "MemberSubscription",
          driverAdapterError: {
            name: "DriverAdapterError",
            cause: {
              originalCode: "23505",
              originalMessage:
                'duplicate key value violates unique constraint "MemberSubscription_memberId_seasonYear_key"',
              kind: "UniqueConstraintViolation",
              constraint: { fields: ['"memberId"', '"seasonYear"'] },
            },
          },
        },
  );
