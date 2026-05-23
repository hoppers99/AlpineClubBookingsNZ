import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import {
  EMAIL_TEMPLATE_KEY_SET,
  getEmailTemplateDefinition,
} from "@/lib/email-message-registry";
import {
  renderEmailTemplatePreview,
  validateEmailTemplateContent,
} from "@/lib/email-message-renderer";
import { requireActiveSessionUser } from "@/lib/session-guards";

const previewSchema = z
  .object({
    templateName: z.string().trim().min(1),
    subject: z.string().trim().min(1).max(500),
    bodyText: z.string().trim().min(1).max(10000),
  })
  .strict();

async function requireAdmin() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return requireActiveSessionUser(session.user.id);
}

export async function POST(request: NextRequest) {
  const inactiveResponse = await requireAdmin();
  if (inactiveResponse) return inactiveResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = previewSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (!EMAIL_TEMPLATE_KEY_SET.has(parsed.data.templateName)) {
    return NextResponse.json({ error: "Unknown email template" }, { status: 400 });
  }

  const validation = validateEmailTemplateContent({
    templateName: parsed.data.templateName,
    subject: parsed.data.subject,
    bodyText: parsed.data.bodyText,
  });
  if (!validation.valid) {
    return NextResponse.json(
      {
        error: "Invalid email template",
        issues: validation.issues,
        unknownTokens: validation.unknownTokens,
        disallowedTokens: validation.disallowedTokens,
        missingRequiredTokens: validation.missingRequiredTokens,
        unsafeLinks: validation.unsafeLinks,
      },
      { status: 400 },
    );
  }

  const definition = getEmailTemplateDefinition(parsed.data.templateName);

  const preview = await renderEmailTemplatePreview({
    subject: parsed.data.subject,
    bodyText: parsed.data.bodyText,
    templateData: definition?.sampleData,
  });

  return NextResponse.json(preview);
}
