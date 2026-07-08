import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/session-guards";
import { isFullAdmin } from "@/lib/access-roles";
import {
  ConfigTransferBundleError,
  MAX_BUNDLE_BYTES,
  resealBundle,
} from "@/lib/config-transfer/bundle";

// POST /api/admin/config-transfer/reseal — full-admin only.
// Accepts a hand-edited bundle (multipart 'bundle' file) and returns a copy with
// its manifest regenerated (fresh checksums + row counts), so it imports without
// integrity warnings. Read-only; no DB mutation. See ADR-001 "hand-edit".

export async function POST(request: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  if (!isFullAdmin({ accessRoles: guard.session.user.accessRoles })) {
    return NextResponse.json(
      { error: "Full admin access is required." },
      { status: 403 },
    );
  }

  let bytes: Uint8Array;
  try {
    const form = await request.formData();
    const file = form.get("bundle");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing 'bundle' file." }, { status: 400 });
    }
    if (file.size > MAX_BUNDLE_BYTES) {
      return NextResponse.json({ error: "Bundle is too large." }, { status: 413 });
    }
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return NextResponse.json(
      { error: "Could not read the uploaded bundle." },
      { status: 400 },
    );
  }

  try {
    const zip = resealBundle(bytes);
    const stamp = new Date().toISOString().slice(0, 10);
    return new NextResponse(new Uint8Array(zip), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="config-transfer-resealed-${stamp}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ConfigTransferBundleError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }
}
