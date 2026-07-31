import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  buildStructuredAuditLogCreateArgs,
  getAuditRequestContext,
} from "@/lib/audit";
import {
  EMAIL_TEMPLATE_DEFINITIONS,
  EMAIL_TEMPLATE_KEY_SET,
} from "@/lib/email-message-registry";
import { findBracketAnnotations } from "@/lib/email-message-token-contract";
import { validateEmailTemplateContent } from "@/lib/email-message-renderer";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session-guards";

interface EmailTemplateOverrideRecord {
  templateName: string;
  subject: string | null;
  bodyText: string | null;
  updatedAt: Date;
  updatedByMemberId: string | null;
}

const templateUpdateSchema = z
  .object({
    templateName: z.string().trim().min(1),
    subject: z.string().trim().max(500).nullable().optional(),
    bodyText: z.string().trim().max(10000).nullable().optional(),
  })
  .strict()
  .refine(
    (value) => value.subject !== undefined || value.bodyText !== undefined,
    "A subject or bodyText update is required",
  );

async function loadOverrides() {
  const delegate = (prisma as unknown as {
    emailTemplateOverride?: {
      findMany: () => Promise<EmailTemplateOverrideRecord[]>;
    };
  }).emailTemplateOverride;

  if (!delegate) return [];
  return delegate.findMany();
}

function serializeOverride(override: EmailTemplateOverrideRecord) {
  return {
    subject: override.subject,
    bodyText: override.bodyText,
    updatedAt: override.updatedAt.toISOString(),
    updatedByMemberId: override.updatedByMemberId,
  };
}

export async function GET() {
  const guard = await requireAdmin({
    permission: { area: "support", level: "view" },
  });
  if (!guard.ok) return guard.response;

  const overrides = await loadOverrides();
  const staleOverrides = overrides
    .filter((override) => !EMAIL_TEMPLATE_KEY_SET.has(override.templateName))
    .map((override) => ({
      templateName: override.templateName,
      ...serializeOverride(override),
    }));
  const overrideByTemplate = new Map(
    overrides
      .filter((override) => EMAIL_TEMPLATE_KEY_SET.has(override.templateName))
      .map((override) => [override.templateName, override]),
  );

  // #2268 review (MED-1): overrides saved from the pre-sweep editor text still
  // carry the "[only when …]" authoring notes as literal member-facing content.
  // Save-time validation now refuses them, but a row that is never re-saved
  // would keep sending the junk forever and nothing would say so. Run guard 1's
  // detector over every stored override (registered AND stale — a stale row can
  // still matter to an operator deciding what to re-author) so the panel can
  // name exactly which templates still carry the junk without an admin opening
  // each one.
  const bracketAnnotationOverrides = overrides
    .map((override) => {
      const findings = findBracketAnnotations({
        [override.templateName]: {
          defaultSubject: override.subject ?? "",
          defaultBody: override.bodyText ?? "",
        },
      });
      if (findings.length === 0) return null;
      return {
        templateName: override.templateName,
        annotations: findings.flatMap((finding) => finding.detail.split(" | ")),
      };
    })
    .filter(
      (entry): entry is { templateName: string; annotations: string[] } =>
        entry !== null,
    );

  // #2307 review (M2): the same failure one level up. A token a template no
  // longer supplies renders as NOTHING — there is no conditional syntax and no
  // error — so an override written against an older default keeps sending, with
  // a hole in it, until somebody happens to re-save. The check-in reminder is
  // the live example: `{{guestFirstName}}`/`{{guestLastName}}` gave way to a
  // one-guest-per-line `{{guestName}}`, and a club holding the old pair would
  // have emailed a reminder listing NOBODY. (The sender keeps supplying the old
  // pair so those overrides still render correctly; this is how the admin
  // learns to move off them.) Reuses the SAVE-TIME validator rather than a
  // second rule, so "your save was refused for this" and "your saved override
  // has this" can never disagree.
  const retiredTokenOverrides = [...overrideByTemplate.entries()]
    .map(([templateName, override]) => {
      const validation = validateEmailTemplateContent({
        templateName,
        subject: override.subject ?? "",
        bodyText: override.bodyText ?? "",
      });
      const tokens = validation.issues
        .filter(
          (issue) => issue.code === "disallowed_token" || issue.code === "unknown_token",
        )
        .flatMap((issue) => issue.tokens ?? []);
      if (tokens.length === 0) return null;
      return { templateName, tokens: Array.from(new Set(tokens)) };
    })
    .filter((entry): entry is { templateName: string; tokens: string[] } => entry !== null);

  return NextResponse.json({
    templates: EMAIL_TEMPLATE_DEFINITIONS.map((definition) => {
      const override = overrideByTemplate.get(definition.key);
      return {
        ...definition,
        override: override ? serializeOverride(override) : null,
      };
    }),
    staleOverrideCount: staleOverrides.length,
    staleOverrides,
    bracketAnnotationOverrides,
    retiredTokenOverrides,
  });
}

export async function PUT(request: NextRequest) {
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

  const parsed = templateUpdateSchema.safeParse(body);
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
    subject: parsed.data.subject ?? "",
    bodyText: parsed.data.bodyText ?? "",
  });
  if (!validation.valid) {
    return NextResponse.json(
      {
        error: "Invalid email template",
        issues: validation.issues,
        unknownTokens: validation.unknownTokens,
        disallowedTokens: validation.disallowedTokens,
        missingRequiredTokens: validation.missingRequiredTokens,
        signPrefixedTokens: validation.signPrefixedTokens,
        sensitiveSubjectTokens: validation.sensitiveSubjectTokens,
        unsafeLinks: validation.unsafeLinks,
        bracketAnnotations: validation.bracketAnnotations,
      },
      { status: 400 },
    );
  }

  const update = {
    subject: parsed.data.subject || null,
    bodyText: parsed.data.bodyText || null,
    updatedByMemberId: session.user.id,
  };
  const before = await prisma.emailTemplateOverride.findUnique({
    where: { templateName: parsed.data.templateName },
  });

  const record = await prisma.emailTemplateOverride.upsert({
    where: { templateName: parsed.data.templateName },
    create: {
      templateName: parsed.data.templateName,
      ...update,
    },
    update,
  });

  await prisma.auditLog.create(
    buildStructuredAuditLogCreateArgs({
      action: "EMAIL_TEMPLATE_OVERRIDE_UPDATED",
      actor: { memberId: session.user.id },
      entity: {
        type: "EmailTemplateOverride",
        id: parsed.data.templateName,
      },
      category: "admin",
      severity: "important",
      outcome: "success",
      summary: "Email template override updated",
      metadata: {
        templateName: parsed.data.templateName,
        previousOverride: before,
        newOverride: update,
      },
      request: getAuditRequestContext(request),
    }),
  );

  return NextResponse.json({ override: record });
}
