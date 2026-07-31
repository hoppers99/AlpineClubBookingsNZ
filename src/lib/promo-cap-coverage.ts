import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import type { PromoCapCoverage } from "@/lib/promo";

type CoverageClient = typeof prisma | Prisma.TransactionClient;

/**
 * What a member is told when a booking edit runs a promotion past its usage cap
 * (#2390). Everyone already benefiting keeps the discount; the people the code
 * no longer reaches are priced normally — and they are named, at the moment of
 * the edit, rather than discovered later on an invoice.
 */
export interface PromoCoverageNotice {
  promoCode: string;
  coveredNames: string[];
  excludedNames: string[];
  message: string;
}

/**
 * "Ann", "Ann and Bob", "Ann, Bob and Cal" — the way a person would say it.
 */
export function joinNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The one sentence every surface uses.
 *
 * Written once, deliberately, because the edit preview, the saved edit's
 * response, the booking-modified email and the booking's own history timeline
 * all show it — and a partial promotion is exactly the case where four
 * separately-worded messages drift into telling four different stories.
 *
 * It says the three things the owner decision asks for: who is covered, who is
 * not, and that the price on screen already reflects it.
 */
export function promoCapCoverageMessage(input: {
  promoCode: string;
  coveredNames: string[];
  excludedNames: string[];
}): string {
  const { promoCode, coveredNames, excludedNames } = input;
  const covered = joinNames(coveredNames);
  const excluded = joinNames(excludedNames);
  const isAre = excludedNames.length === 1 ? "is" : "are";

  const keptClause = covered
    ? `it stays with ${covered}, who already had it`
    : "it stays with everyone who already had it";

  return (
    `Promo code ${promoCode} has reached its limit, so ${keptClause}, ` +
    `and does not extend to ${excluded} — ${excluded} ${isAre} priced at the ` +
    `normal rate. The total shown already includes this.`
  );
}

/**
 * Turn the member ids a reprice left out into the sentence above.
 *
 * Names come from the `Member` rows, because a promotion's beneficiaries are
 * members: an unassigned code benefits the booker, and an assigned code
 * benefits its linked member guests. Reading them here rather than threading
 * names through five call sites is what keeps every surface on identical
 * wording.
 *
 * Returns `null` when nobody was left out, so callers can treat "is there
 * anything to say?" as a single check. A member whose row cannot be read is
 * skipped rather than named as "undefined"; if that empties the excluded list
 * the notice is dropped, since a message that names nobody is worse than none.
 */
export async function describePromoCapCoverage(
  db: CoverageClient,
  input: { promoCode: string; capCoverage: PromoCapCoverage | undefined }
): Promise<PromoCoverageNotice | null> {
  const { promoCode, capCoverage } = input;
  if (!capCoverage || capCoverage.excludedMemberIds.length === 0) return null;

  const memberIds = [
    ...new Set([...capCoverage.coveredMemberIds, ...capCoverage.excludedMemberIds]),
  ];
  const members = await db.member.findMany({
    where: { id: { in: memberIds } },
    select: { id: true, firstName: true, lastName: true },
  });
  const nameById = new Map(
    members.map((member) => [
      member.id,
      `${member.firstName ?? ""} ${member.lastName ?? ""}`.trim(),
    ])
  );
  const namesFor = (ids: string[]) =>
    ids.map((id) => nameById.get(id) ?? "").filter((name) => name.length > 0);

  const coveredNames = namesFor(capCoverage.coveredMemberIds);
  const excludedNames = namesFor(capCoverage.excludedMemberIds);
  if (excludedNames.length === 0) return null;

  return {
    promoCode,
    coveredNames,
    excludedNames,
    message: promoCapCoverageMessage({ promoCode, coveredNames, excludedNames }),
  };
}
