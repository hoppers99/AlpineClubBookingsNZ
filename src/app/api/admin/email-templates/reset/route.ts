import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import { EMAIL_TEMPLATE_KEY_SET } from "@/lib/email-message-registry";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

const resetSchema = z.object({
  templateName: z.string().trim().min(1),
});

export async function POST(request: NextRequest) {
  const guard = await requireAdmin({
    permission: { area: "support", level: "edit" },
  });
  if (!guard.ok) return guard.response;
  const session = guard.session;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = resetSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (!EMAIL_TEMPLATE_KEY_SET.has(parsed.data.templateName)) {
    return NextResponse.json({ error: "Unknown email template" }, { status: 400 });
  }

  // #2269 review: this is one click, irreversible, and the editor now points at
  // it from three different places. Read the row BEFORE deleting it and record
  // the wording in the audit metadata — the same content #2269's own migration
  // treats as precious enough to store in full when it edits a single line of
  // it. Without this the destroyed subject and body existed nowhere afterwards
  // and a club that reset by mistake had lost years of wording for good.
  const before = await prisma.emailTemplateOverride.findUnique({
    where: { templateName: parsed.data.templateName },
  });

  const result = await prisma.emailTemplateOverride.deleteMany({
    where: { templateName: parsed.data.templateName },
  });
  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "EMAIL_TEMPLATE_OVERRIDE_RESET",
      actor: { memberId: session.user.id },
      entity: {
        type: "EmailTemplateOverride",
        id: parsed.data.templateName,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Email template override reset",
      metadata: {
        templateName: parsed.data.templateName,
        deletedOverride: before
          ? {
              subject: before.subject,
              bodyText: before.bodyText,
              updatedByMemberId: before.updatedByMemberId,
              updatedAt: before.updatedAt.toISOString(),
            }
          : null,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({ reset: result.count > 0 });
}
