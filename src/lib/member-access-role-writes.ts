import type { FinanceAccessLevel, Prisma, Role } from "@prisma/client";
import {
  accessRolesFromCompatibilityFields,
  normalizeAssignableAccessRoles,
  type AppAccessRole,
} from "@/lib/access-roles";

type MemberAccessRoleWriter = {
  memberAccessRole: Pick<
    Prisma.TransactionClient["memberAccessRole"],
    "createMany"
  >;
};

export async function ensureMemberAccessRoles(
  db: MemberAccessRoleWriter,
  params: {
    memberId: string;
    roles: ReadonlyArray<AppAccessRole | string | null | undefined>;
    canLogin?: boolean | null;
    assignedByMemberId?: string | null;
  },
) {
  const roles = normalizeAssignableAccessRoles(params.roles, {
    canLogin: params.canLogin,
  });

  if (roles.length === 0) {
    return { count: 0, roles };
  }

  const assignedByMemberId = params.assignedByMemberId?.trim() || null;
  const result = await db.memberAccessRole.createMany({
    data: roles.map((role) => ({
      memberId: params.memberId,
      role,
      ...(assignedByMemberId ? { assignedByMemberId } : {}),
    })),
    skipDuplicates: true,
  });

  return { count: result.count, roles };
}

export async function ensureMemberAccessRolesFromCompatibilityFields(
  db: MemberAccessRoleWriter,
  params: {
    memberId: string;
    role?: Role | string | null;
    financeAccessLevel?: FinanceAccessLevel | string | null;
    canLogin?: boolean | null;
    assignedByMemberId?: string | null;
  },
) {
  const roles = accessRolesFromCompatibilityFields({
    role: params.role,
    financeAccessLevel: params.financeAccessLevel,
    canLogin: params.canLogin,
  });

  return ensureMemberAccessRoles(db, {
    memberId: params.memberId,
    roles,
    canLogin: params.canLogin,
    assignedByMemberId: params.assignedByMemberId,
  });
}
