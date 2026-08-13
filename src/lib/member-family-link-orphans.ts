import type { Prisma } from "@prisma/client";
import { memberName } from "@/lib/member-serialization";
import type { prisma } from "@/lib/prisma";

/**
 * Members whose family links are about to be cleared as a side effect of
 * removing someone else from the club (#2255).
 *
 * Two lifecycle paths do the identical sweep — cancellation approval and
 * archive approval — and with chains of up to four generations the member being
 * removed is often a MIDDLE generation, so the sweep detaches their own
 * dependants from the family and leaves anyone inheriting their address with no
 * mailbox. Neither is an error and neither is a blocker; both are collateral
 * the admin has to be told about, because nothing else on any screen would say
 * so.
 *
 * Dependants are deliberately NOT re-parented onto the grandparent: who is
 * responsible for a member is a real-world fact, and promoting it because
 * someone left the club would record a relationship nobody asserted.
 */
export type OrphanedFamilyLinks = {
  /** Lost a parent link to the member being removed. */
  dependants: Array<{ id: string; name: string; email: string }>;
  /** Lost the mailbox their notifications were being delivered to. */
  emailInheritors: Array<{ id: string; name: string; email: string }>;
};

export const EMPTY_ORPHANED_FAMILY_LINKS: OrphanedFamilyLinks = {
  dependants: [],
  emailInheritors: [],
};

type OrphanReaderClient = Prisma.TransactionClient | typeof prisma;

/**
 * Read who the sweep is about to detach. MUST be called BEFORE the columns are
 * nulled, and on the same client that will null them — afterwards there is no
 * record of the links at all, which is the whole reason this exists.
 */
export async function readFamilyLinkOrphans(
  db: OrphanReaderClient,
  memberId: string,
): Promise<OrphanedFamilyLinks> {
  const select = {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
  } satisfies Prisma.MemberSelect;
  const orderBy: Prisma.MemberOrderByWithRelationInput[] = [
    { lastName: "asc" },
    { firstName: "asc" },
  ];

  const [dependants, emailInheritors] = await Promise.all([
    db.member.findMany({
      where: {
        OR: [{ parentMemberId: memberId }, { secondaryParentId: memberId }],
      },
      select,
      orderBy,
    }),
    // #2716: matched on the CHOICE as well as the pointer. A member whose chosen
    // source has temporarily gone unreachable holds the choice with a NULL
    // pointer, and they are the ones with most to lose here — they were already
    // waiting for that mailbox to come back, and removing the member is what
    // makes the wait permanent. Reading only the pointer would leave them out of
    // the declaration the admin is shown and out of the audit record, which is
    // the exact silence this helper exists to end.
    db.member.findMany({
      where: {
        OR: [
          { inheritEmailFromId: memberId },
          { inheritEmailChoiceId: memberId },
        ],
      },
      select,
      orderBy,
    }),
  ]);

  const describe = (member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  }) => ({ id: member.id, name: memberName(member), email: member.email });

  return {
    dependants: dependants.map(describe),
    emailInheritors: emailInheritors.map(describe),
  };
}
