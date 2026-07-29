import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { isPlaceholderContactEmail } from "@/lib/placeholder-contact-email";

type InheritanceValidationResult =
  | { ok: true }
  | { ok: false; status: 404 | 422; error: string };

type EmailInheritanceClient = Prisma.TransactionClient | typeof prisma;

export async function validateInheritEmailSource(input: {
  inheritEmailFromId: string;
  memberId?: string;
  db?: EmailInheritanceClient;
}, dbOverride?: EmailInheritanceClient): Promise<InheritanceValidationResult> {
  const db = dbOverride ?? input.db ?? prisma;
  const inheritEmailFrom = await db.member.findUnique({
    where: { id: input.inheritEmailFromId },
    select: {
      id: true,
      ageTier: true,
      email: true,
      inheritEmailFromId: true,
      archivedAt: true,
    },
  });

  if (!inheritEmailFrom) {
    return {
      ok: false,
      status: 404,
      error: "Email inheritance member not found",
    };
  }

  if (input.memberId && inheritEmailFrom.id === input.memberId) {
    return {
      ok: false,
      status: 422,
      error: "Email inheritance cannot point to the same member",
    };
  }

  if (inheritEmailFrom.ageTier !== "ADULT") {
    return {
      ok: false,
      status: 422,
      error: "Email inheritance must point to an adult member",
    };
  }

  // #2255 (D9): the source may now itself have parents. Family links run to
  // four generations, so the nearest ancestor with a real mailbox is often a
  // MIDDLE generation — an adult who is someone's child and someone's parent at
  // once. The old "must point to a primary adult member" clause (source has no
  // parents) made that source unusable and left the third generation's children
  // with no reachable contact, which is the whole reason D9 asks for transitive
  // resolution. The two guarantees that actually matter are kept below and
  // unchanged: the source must be an ADULT, and it must be TERMINAL.

  if (inheritEmailFrom.inheritEmailFromId) {
    return {
      ok: false,
      status: 422,
      error: "Email inheritance cannot chain through another inherited member",
    };
  }

  if (inheritEmailFrom.archivedAt) {
    return {
      ok: false,
      status: 422,
      error: "Email inheritance cannot point to an archived member",
    };
  }

  // #2255 (D9): with the "source has no parents" clause gone, the remaining
  // structural guards no longer imply a DELIVERABLE address, so check it
  // directly. A walk-in placeholder (`@no-email.invalid`, #1935) is silently
  // dropped by `sendEmail`, so inheriting one would leave the dependant with no
  // reachable contact at all while the admin UI showed an inheritance in place.
  if (isPlaceholderContactEmail(inheritEmailFrom.email)) {
    return {
      ok: false,
      status: 422,
      error:
        "Email inheritance must point to a member with a real email address",
    };
  }

  return { ok: true };
}
