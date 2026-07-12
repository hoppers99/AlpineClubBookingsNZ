import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { hasAdminAccess } from "@/lib/access-roles";
import { checkDisplayAuth } from "@/lib/lodge-display-auth";
import { buildDisplayState, type DisplayState } from "@/lib/lodge-display-state";
import {
  resolveDisplayTemplate,
  resolveDisplayTemplateForDevice,
} from "@/lib/lodge-display/template-resolution";
import { buildLayoutRender } from "@/lib/lodge-display/layout-render";
import type { LayoutRenderPayload } from "@/lib/lodge-display/layout-registry";
import { getDefaultLodgeId } from "@/lib/lodges";
import { isDateOnlyString, parseDateOnly } from "@/lib/date-only";
import { prisma } from "@/lib/prisma";
import { applyRateLimit, rateLimiters } from "@/lib/rate-limit";

// GET /api/display/state?days=N — the lobby display's single data feed
// (fork issues #28/#32/#52, design.md §5). Two callers:
//
//  - a PAIRED DEVICE (display-token cookie): the device's bound lodge and
//    template; a successful fetch stamps lastSeenAt so admins can see a dead
//    screen (the page polls this — no separate heartbeat needed).
//  - an ADMIN PREVIEW (issue #52; the kiosk per-account preview pattern,
//    upstream #1721): a full admin passes ?previewDevice=<id> (that device's
//    lodge + template) or ?preview=1[&templateKey=…] (default lodge). Preview
//    is read-only by construction — it never stamps lastSeenAt — and renders
//    through the SAME privacy-reduced serialiser, so a preview can never show
//    more than a lobby wall would. The parameter is honoured ONLY for a full
//    admin; anyone else gets the normal 401. A preview may also carry
//    ?previewDate=YYYY-MM-DD (issue #60) to start the window on a simulated
//    date instead of today — preview-only; device fetches never honour it.
//
// The serialiser (lodge-display-state.ts) is the privacy enforcement point;
// nothing here shapes or filters names. Window size is clamped server-side
// (default 3 days, max 7). Module flag off → proxy-level 404.

async function resolvePreview(
  req: NextRequest
): Promise<
  | { lodgeId: string; templateId: string | null; templateKey: string | null }
  | "not-a-preview"
  | "denied"
> {
  const previewDeviceId = req.nextUrl.searchParams.get("previewDevice");
  const previewFlag = req.nextUrl.searchParams.get("preview");
  if (!previewDeviceId && !previewFlag) return "not-a-preview";

  const session = await auth();
  if (!session?.user?.id) return "denied";
  const member = await prisma.member.findUnique({
    where: { id: session.user.id },
    select: { id: true, accessRoles: { select: { role: true } } },
  });
  if (!member || !hasAdminAccess(member)) return "denied";

  if (previewDeviceId) {
    const device = await prisma.lodgeDisplayDevice.findUnique({
      where: { id: previewDeviceId },
      select: { lodgeId: true, templateId: true, templateKey: true },
    });
    if (!device) return "denied";
    return device;
  }

  return {
    lodgeId: await getDefaultLodgeId(prisma),
    templateId: null,
    templateKey: req.nextUrl.searchParams.get("templateKey"),
  };
}

// Load a device's bound v2 Template + its Layout and assemble the sanitised,
// validated `layoutRender` payload (LTV-027). Returns null on any failure — a
// missing row, a validation/sanitise error, or a DB error — so the caller keeps
// the legacy code-built-in `template` field and never serves a broken payload
// (LTV-030 formalises the fallback; this is the simple safe version). Devices
// without templateId never reach here and keep the legacy behaviour unchanged.
async function loadLayoutRender(
  templateId: string,
  // LTV-028: value tokens ({{config:…}}/{{lodge-name}}/{{display-date}}) resolve
  // against the bound lodge's DisplayState at serve time, so the render needs it.
  state: DisplayState
): Promise<LayoutRenderPayload | null> {
  try {
    const template = await prisma.displayTemplate.findUnique({
      where: { id: templateId },
      select: {
        slotContent: true,
        cssOverrides: true,
        footerHtml: true,
        layout: {
          select: { bodyHtml: true, defaultCss: true, areas: true },
        },
      },
    });
    if (!template) return null;
    return buildLayoutRender(
      {
        bodyHtml: template.layout.bodyHtml,
        defaultCss: template.layout.defaultCss,
        areas: template.layout.areas,
        slotContent: template.slotContent,
        cssOverrides: template.cssOverrides,
        footerHtml: template.footerHtml,
      },
      state
    );
  } catch {
    return null;
  }
}

// The simulated preview start date (issue #60): strict date-only shape plus a
// real-calendar validity check. Malformed values fall back to today silently
// (null → the serialiser starts from today). Preview-only; the caller must
// never reach this from the device path.
function parsePreviewDate(req: NextRequest): Date | null {
  const raw = req.nextUrl.searchParams.get("previewDate");
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !isDateOnlyString(raw)) {
    return null;
  }
  return parseDateOnly(raw);
}

export async function GET(req: NextRequest) {
  const rateLimited = await applyRateLimit(rateLimiters.api, req);
  if (rateLimited) return rateLimited;

  const daysParam = req.nextUrl.searchParams.get("days");
  const days = daysParam === null ? null : Number(daysParam);

  const deviceAuth = await checkDisplayAuth(req);
  if (deviceAuth) {
    const state = await buildDisplayState(deviceAuth.device.lodgeId, { days });
    if (!state) {
      // The device's lodge no longer exists or is inactive — treat exactly
      // like a failed auth rather than serving a partial payload (AC8).
      return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
    }
    const template = resolveDisplayTemplateForDevice(deviceAuth.device);
    // The poll doubles as the device heartbeat (issue #52): only genuine
    // device-token fetches stamp lastSeenAt — previews never do.
    await prisma.lodgeDisplayDevice.update({
      where: { id: deviceAuth.device.id },
      data: { lastSeenAt: new Date() },
    });
    // A device bound to a v2 Template (templateId) renders through the layout
    // engine; the legacy `template` field always ships too, as the safe
    // fallback the client uses when layoutRender is absent (LTV-027/030).
    const layoutRender = deviceAuth.device.templateId
      ? await loadLayoutRender(deviceAuth.device.templateId, state)
      : null;
    return NextResponse.json({
      ...state,
      template: template.definition,
      ...(layoutRender ? { layoutRender } : {}),
    });
  }

  const preview = await resolvePreview(req);
  if (preview === "not-a-preview" || preview === "denied") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const state = await buildDisplayState(preview.lodgeId, {
    days,
    windowStart: parsePreviewDate(req),
  });
  if (!state) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }
  const template = preview.templateKey
    ? (resolveDisplayTemplate(preview.templateKey) ??
      resolveDisplayTemplateForDevice(preview))
    : resolveDisplayTemplateForDevice(preview);
  // ?previewDevice of a v2-bound device renders the layout engine; ?preview=1
  // (templateId null, e.g. &templateKey=…) stays on the legacy path.
  const layoutRender = preview.templateId
    ? await loadLayoutRender(preview.templateId, state)
    : null;
  return NextResponse.json({
    ...state,
    template: template.definition,
    ...(layoutRender ? { layoutRender } : {}),
  });
}
