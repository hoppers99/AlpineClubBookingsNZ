import { NextResponse } from "next/server";
import { z } from "zod";
import {
  approveBedAllocations,
  parseBedAllocationDateRange,
} from "@/lib/admin-bed-allocation";
import {
  bedAllocationErrorResponse,
  requireBedAllocationWrite,
} from "@/lib/admin-bed-allocation-routes";
import { parseJsonRequestBody } from "@/lib/api-json";
import { prisma } from "@/lib/prisma";
import { resolveOptionalActiveLodgeId } from "@/lib/lodges";

// requireAdmin() is enforced by requireBedAllocationWrite().
/*
  #2887 (owner decision 7): the WINDOW selector must name a lodge.

  `approve` was the last board mutation with no server-side lodge refusal — its
  sibling `auto-allocate` already requires one. Omitting `lodgeId` made the
  service lock every lodge and approve across all of them, so any `bookings:edit`
  admin could approve the whole club's visible drafts with a hand-made request.
  The board disables the button and its handler requires a concrete lodge, but
  a disabled button is not a guard.

  The requirement is on the BROAD selectors only, and deliberately so rather
  than a blanket `.min(1)`:

    - `from`/`to`, or no selector at all, means "approve everything matching",
      which is exactly the club-wide sweep the decision is about. Refused
      without a lodge.
    - `allocationIds` and `bookingId` have already named the rows they touch.
      Forcing a lodge onto a caller that enumerated its own row ids adds no
      safety, and the E2E cleanup paths legitimately restore approvals by id.

  Cross-lodge writes stay refused by the writers themselves either way; this
  narrows what may be ASKED for.
*/
const approveSchema = z
  .object({
    allocationIds: z.array(z.string().min(1)).max(250).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    // One booking's draft rows; sufficient without either broader selector.
    bookingId: z.string().min(1).optional(),
    // Board lodge scope. Required for the window/unscoped sweep — see above.
    lodgeId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const namesRows =
      (data.allocationIds !== undefined && data.allocationIds.length > 0) ||
      data.bookingId !== undefined;
    if (namesRows || data.lodgeId !== undefined) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lodgeId"],
      message:
        "lodgeId is required to approve a date window; approving every lodge at once is not offered.",
    });
  });

export async function POST(request: Request) {
  const guard = await requireBedAllocationWrite();
  if (!guard.ok) return guard.response;

  try {
    const json = await parseJsonRequestBody(request);
    if (!json.ok) return json.response;

    const body = approveSchema.safeParse(json.body);
    if (!body.success) {
      return NextResponse.json(
        { error: "Invalid input", details: body.error.flatten() },
        { status: 400 },
      );
    }

    // A named lodge must be a real, ACTIVE one — same treatment the
    // `auto-allocate` sibling gives it, so the two doors agree.
    let lodgeId: string | undefined;
    if (body.data.lodgeId !== undefined) {
      const resolved = await resolveOptionalActiveLodgeId(
        prisma,
        body.data.lodgeId,
      );
      if (!resolved) {
        return NextResponse.json(
          { error: "Lodge not found or not active" },
          { status: 400 },
        );
      }
      lodgeId = resolved;
    }

    const range =
      body.data.from || body.data.to
        ? parseBedAllocationDateRange({
            from: body.data.from,
            to: body.data.to,
          })
        : undefined;
    // The service owns the approval and its audit in the same transaction.
    const result = await approveBedAllocations({
      approvedByMemberId: guard.session.user.id,
      allocationIds: body.data.allocationIds,
      range,
      bookingId: body.data.bookingId,
      lodgeId,
    });

    return NextResponse.json({ approvedCount: result.count });
  } catch (error) {
    return bedAllocationErrorResponse(error);
  }
}
