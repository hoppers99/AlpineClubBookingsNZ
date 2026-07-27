import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/session-guards";
import { prisma } from "@/lib/prisma";
import { resolveInheritedEmailSourceId } from "@/lib/member-parent-links";
import logger from "@/lib/logger";

class UnlinkDependentError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 422
  ) {
    super(message);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; dependentId: string }> }
) {
  const guard = await requireAdmin({
    permission: { area: "membership", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;
  const { id: parentId, dependentId } = await params;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const parent = await tx.member.findUnique({
        where: { id: parentId },
        // The parent's own email source is no longer read: provenance is
        // decided by the dependant's `inheritParentEmail` flag, not by matching
        // the stored pointer against this parent's one-hop source.
        select: { id: true },
      });
      if (!parent) {
        throw new UnlinkDependentError("Parent member not found", 404);
      }

      const dependent = await tx.member.findUnique({
        where: { id: dependentId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          active: true,
          canLogin: true,
          parentMemberId: true,
          secondaryParentId: true,
          inheritParentEmail: true,
          inheritEmailFromId: true,
          // Only the id is used — the transitive resolver reads the rest of the
          // chain itself, from the transaction's own view.
          parent: { select: { id: true } },
          secondaryParent: { select: { id: true } },
        },
      });
      if (!dependent) {
        throw new UnlinkDependentError("Dependent member not found", 404);
      }
      const isPrimaryParent = dependent.parentMemberId === parent.id;
      const isSecondaryParent = dependent.secondaryParentId === parent.id;
      if (!isPrimaryParent && !isSecondaryParent) {
        throw new UnlinkDependentError(
          "This member is not linked as a dependant of that parent",
          422
        );
      }

      // PROVENANCE, not identity (#2255). This used to ask "does the stored
      // pointer name this parent, or this parent's own source?" — a ONE-HOP
      // test. Since the write side resolves transitively, a derived pointer now
      // routinely names an ancestor two or more hops up (link a child under a
      // grandparent whose address is a placeholder and the stored source is the
      // GREAT-grandparent). That pointer failed the one-hop test, so unlinking
      // left the member with no parent link at all and a permanent inheritance
      // from someone they are no longer connected to — while the response and
      // the audit entry both said `clearedEmailInheritance: false`, as if that
      // were the correct outcome.
      //
      // `inheritParentEmail` is the provenance flag: every pointer this system
      // derives from a parent link sets it true, and a manually-chosen source
      // sets it false. So a DERIVED pointer is re-resolved on unlink whatever
      // it names, and a MANUAL one is left alone — the distinction the manual
      // case in dependent-unlink.test.ts pins.
      const shouldClearEmailInheritance =
        dependent.inheritParentEmail && dependent.inheritEmailFromId !== null;
      const remainingParent = isPrimaryParent
        ? dependent.secondaryParent
        : dependent.parent;
      // Re-resolve through the same transitive resolver the link route uses, so
      // a dependant who falls back onto a middle-generation parent with no
      // mailbox of their own lands on that parent's nearest reachable ancestor
      // rather than on nothing. A one-hop read here would silently clear it.
      const nextEmailSourceId = shouldClearEmailInheritance
        ? remainingParent
          ? (await resolveInheritedEmailSourceId(tx, remainingParent.id)).sourceId
          : null
        : dependent.inheritEmailFromId;

      const updateData = {
        ...(isPrimaryParent
          ? dependent.secondaryParentId
            ? {
                parent: { connect: { id: dependent.secondaryParentId } },
                secondaryParent: { disconnect: true },
              }
            : { parent: { disconnect: true } }
          : { secondaryParent: { disconnect: true } }),
        ...(shouldClearEmailInheritance
          ? nextEmailSourceId
            ? {
                inheritParentEmail: true,
                inheritEmailFrom: { connect: { id: nextEmailSourceId } },
              }
            : {
                inheritParentEmail: false,
                inheritEmailFrom: { disconnect: true },
              }
          : {}),
      };

      const updated = await tx.member.update({
        where: { id: dependent.id },
        data: updateData,
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          ageTier: true,
          active: true,
          canLogin: true,
          parentMemberId: true,
          secondaryParentId: true,
          inheritParentEmail: true,
          inheritEmailFromId: true,
        },
      });

      await tx.auditLog.create({
        data: {
          action: "member.dependent.unlink",
          memberId: session.user.id,
          targetId: dependent.id,
          details: JSON.stringify({
            parentMemberId: parent.id,
            linkType: isPrimaryParent ? "PRIMARY" : "SECONDARY",
            promotedSecondaryParent: isPrimaryParent && Boolean(dependent.secondaryParentId),
            clearedEmailInheritance: shouldClearEmailInheritance,
            nextEmailSourceId,
          }),
        },
      });

      return {
        updated,
        clearedEmailInheritance: shouldClearEmailInheritance,
        promotedSecondaryParent: isPrimaryParent && Boolean(dependent.secondaryParentId),
      };
    });

    return NextResponse.json({
      member: result.updated,
      clearedEmailInheritance: result.clearedEmailInheritance,
      promotedSecondaryParent: result.promotedSecondaryParent,
    });
  } catch (error) {
    if (error instanceof UnlinkDependentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    logger.error({ err: error, parentId, dependentId }, "Failed to unlink dependant");
    return NextResponse.json({ error: "Failed to unlink dependant" }, { status: 500 });
  }
}
