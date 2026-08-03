import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ageTierEnum } from "@/lib/age-tier-schema";
import { formatMemberIdentityAge } from "@/lib/member-age";

/**
 * Member lookup for the identity-sensitive Family Group admin workflows (#2568).
 *
 * Why this exists instead of reusing `GET /api/admin/members`: that endpoint
 * answers the members ADMIN TABLE, whose own editor needs the stored date of
 * birth, so every search response carries it. The Family Group workflows only
 * ever need to tell one similarly-named person from another, so they get a
 * purpose-built response that carries the CALCULATED AGE and no date of birth at
 * all. Both endpoints sit behind the same membership-view permission; this one
 * simply hands the browser less.
 *
 * The result set is deliberately narrow: active, non-archived members only,
 * capped at ten rows, optionally restricted to a set of age tiers (the
 * infant/child/youth restriction a dependant request needs). `total` is the full
 * match count so a caller can say when a list was cut short.
 */

const MAX_RESULTS = 10;

export const familyGroupMemberSearchQuerySchema = z.object({
  q: z.string().trim().min(2, "Enter at least 2 characters").max(100),
  // CSV, e.g. "INFANT,CHILD,YOUTH". An empty or absent value means no tier
  // restriction; an unrecognised tier is a 400 rather than a silent widening.
  ageTierIn: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value ? value.split(",").map((part) => part.trim()) : undefined))
    .pipe(z.array(ageTierEnum).min(1).optional()),
});

export type FamilyGroupMemberSearchQuery = z.infer<
  typeof familyGroupMemberSearchQuerySchema
>;

export interface FamilyGroupMemberSearchRow {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ageTier: string;
  active: boolean;
  canLogin: boolean;
  /** Calculated server-side; see `formatMemberIdentityAge`. Never a birth date. */
  ageLabel: string;
}

// Same name/email predicate the members admin search uses, so an admin who
// types a name here finds the same people they would find there.
function buildTextSearchCondition(query: string): Prisma.MemberWhereInput {
  const terms = query.split(/\s+/).filter(Boolean);

  return {
    OR: [
      { firstName: { contains: query, mode: "insensitive" } },
      { lastName: { contains: query, mode: "insensitive" } },
      { email: { contains: query, mode: "insensitive" } },
      ...(terms.length > 1
        ? [
            {
              AND: terms.map(
                (term): Prisma.MemberWhereInput => ({
                  OR: [
                    { firstName: { contains: term, mode: "insensitive" } },
                    { lastName: { contains: term, mode: "insensitive" } },
                    { email: { contains: term, mode: "insensitive" } },
                  ],
                })
              ),
            },
          ]
        : []),
    ],
  };
}

export async function searchFamilyGroupCandidateMembers(
  query: FamilyGroupMemberSearchQuery
): Promise<{ members: FamilyGroupMemberSearchRow[]; total: number }> {
  const where: Prisma.MemberWhereInput = {
    active: true,
    archivedAt: null,
    ...(query.ageTierIn ? { ageTier: { in: query.ageTierIn } } : {}),
    AND: [buildTextSearchCondition(query.q)],
  };

  const [members, total] = await Promise.all([
    prisma.member.findMany({
      where,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        ageTier: true,
        active: true,
        canLogin: true,
        // Read to calculate the age below, and dropped from the mapped row.
        dateOfBirth: true,
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: MAX_RESULTS,
    }),
    prisma.member.count({ where }),
  ]);

  return {
    members: members.map((member) => ({
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      ageTier: member.ageTier,
      active: member.active,
      canLogin: member.canLogin,
      ageLabel: formatMemberIdentityAge(member.dateOfBirth),
    })),
    total,
  };
}
