import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { isEffectiveModuleEnabled } from "@/lib/admin-modules";
import { BedAllocationAdminError } from "@/lib/admin-bed-allocation";
import { requireAdmin } from "@/lib/session-guards";

export async function requireBedAllocationAdmin() {
  const guard = await requireAdmin();
  if (!guard.ok) {
    return { ok: false as const, response: guard.response };
  }

  if (!(await isEffectiveModuleEnabled("bedAllocation"))) {
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Not found" }, { status: 404 }),
    };
  }

  return { ok: true as const, session: guard.session };
}

export function bedAllocationErrorResponse(error: unknown) {
  if (error instanceof BedAllocationAdminError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return NextResponse.json(
        { error: "A room or bed with that name already exists." },
        { status: 409 },
      );
    }
    if (error.code === "P2025") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (error.code === "P2003") {
      return NextResponse.json(
        { error: "Cannot delete a bed with allocation history; deactivate it instead." },
        { status: 409 },
      );
    }
    // Write conflict / deadlock the database resolved by aborting us. Nothing
    // was written, and trying again usually succeeds — so say that, rather than
    // letting it fall through to a generic 500 (#2251 review A3). The range path
    // already retries this once itself before it can reach here.
    if (error.code === "P2034") {
      return NextResponse.json(
        {
          error:
            "That change collided with another one being saved at the same moment. Nothing was written — reload and try again.",
        },
        { status: 409 },
      );
    }
    // The transaction ran out of time (or was already closed). Again nothing was
    // committed, and the actionable advice is specific: ask for less at once.
    if (error.code === "P2028") {
      return NextResponse.json(
        {
          error:
            "That took too long to save and was rolled back — nothing was written. Try a shorter date range.",
        },
        { status: 503 },
      );
    }
  }

  return NextResponse.json(
    { error: "Bed allocation request failed" },
    { status: 500 },
  );
}
