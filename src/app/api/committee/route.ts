import { NextResponse } from "next/server";
import {
  committeeAssignmentOrderBy,
  publicCommitteeAssignmentSelect,
  serializePublicCommitteeAssignment,
} from "@/lib/committee";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/committee
 * Public endpoint: returns published committee assignments with server-curated
 * contact metadata. Member email addresses are never selected or returned.
 */
export async function GET() {
  const [assignments, settings] = await Promise.all([
    prisma.committeeAssignment.findMany({
      where: {
        isActive: true,
        published: true,
        committeeRole: { isActive: true },
        member: { active: true },
      },
      orderBy: committeeAssignmentOrderBy(),
      // No row cap: the roster shows every published, active committee
      // assignment — exactly the set whose photos /api/members/[id]/photo serves
      // publicly. A cap here would silently hide members past it whose photos
      // stayed publicly fetchable (visibility must stay in lockstep). Committee
      // assignments are curated admin data, so the set is inherently small.
      select: publicCommitteeAssignmentSelect,
    }),
    prisma.publicContentSettings.findUnique({
      where: { id: "default" },
      select: { committeePhotoDisplay: true },
    }),
  ]);

  // MP5 (#171): the club opts the public roster into photos (NONE default). When
  // disabled, no photo metadata is emitted at all.
  const photoDisplay = settings?.committeePhotoDisplay ?? "NONE";
  const includePhoto = photoDisplay !== "NONE";
  const members = assignments.map((assignment) =>
    serializePublicCommitteeAssignment(assignment, { includePhoto }),
  );

  return NextResponse.json({ members, photoDisplay });
}
