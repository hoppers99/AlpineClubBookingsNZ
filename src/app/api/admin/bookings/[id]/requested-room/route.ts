import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { loadEffectiveModuleFlags } from "@/lib/module-settings";
import {
  requestedRoomWriteErrorResponse,
  writeRequestedRoom,
} from "@/lib/requested-room-write";
import { requireAdmin } from "@/lib/session-guards";

const requestedRoomSchema = z
  .object({ requestedRoomId: z.string().min(1) })
  .strict();

async function requireRoomRequestsEnabled() {
  const modules = await loadEffectiveModuleFlags();
  return modules.bedAllocation
    ? null
    : NextResponse.json(
        { error: "Room requests are not available." },
        { status: 400 },
      );
}

function errorResponse(error: unknown) {
  const mapped = requestedRoomWriteErrorResponse(error);
  return NextResponse.json({ error: mapped.error }, { status: mapped.status });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const disabled = await requireRoomRequestsEnabled();
  if (disabled) return disabled;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = requestedRoomSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const { id } = await params;
    const updated = await writeRequestedRoom({
      bookingId: id,
      actorMemberId: guard.session.user.id,
      actorIsAdmin: true,
      requestedRoomId: parsed.data.requestedRoomId,
      auditActorLabel: "Admin",
    });
    return NextResponse.json(updated);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireAdmin({
    permission: { area: "bookings", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const disabled = await requireRoomRequestsEnabled();
  if (disabled) return disabled;

  try {
    const { id } = await params;
    const updated = await writeRequestedRoom({
      bookingId: id,
      actorMemberId: guard.session.user.id,
      actorIsAdmin: true,
      requestedRoomId: null,
      auditActorLabel: "Admin",
    });
    return NextResponse.json(updated);
  } catch (error) {
    return errorResponse(error);
  }
}
