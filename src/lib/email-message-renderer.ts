import { plainTextEmailTemplate } from "@/lib/email-templates";
import {
  applyEmailMessageSettingsToHtml,
  applyEmailMessageSettingsToSubject,
  buildEmailTemplateGlobalData,
  loadEmailMessageSettings,
  type EmailMessageSettings,
} from "@/lib/email-message-settings";
import {
  APPROVED_EMAIL_TEMPLATE_TOKEN_SET,
  getEmailTemplateDefinition,
} from "@/lib/email-message-registry";
import { prisma } from "@/lib/prisma";

export type EmailTemplateValue = string | number | boolean | null | undefined;
export type EmailTemplateData = Record<string, EmailTemplateValue>;

export interface EmailTemplateOverrideRecord {
  templateName: string;
  subject: string | null;
  bodyText: string | null;
  updatedAt?: Date | string | null;
  updatedByMemberId?: string | null;
}

export interface PreparedEmailMessage {
  subject: string;
  html: string;
  settings: EmailMessageSettings;
  overrideApplied: boolean;
}

export interface EmailTemplateValidationIssue {
  code:
    | "unknown_template"
    | "unknown_token"
    | "disallowed_token"
    | "missing_required_token"
    | "subject_line_break"
    | "raw_html"
    | "unsafe_link";
  field?: "subject" | "bodyText";
  message: string;
  tokens?: string[];
  links?: string[];
}

export interface EmailTemplateValidationResult {
  valid: boolean;
  issues: EmailTemplateValidationIssue[];
  unknownTokens: string[];
  disallowedTokens: string[];
  missingRequiredTokens: string[];
  unsafeLinks: string[];
}

export function extractTemplateTokens(value: string): string[] {
  return Array.from(value.matchAll(/\{\{([^{}]+)\}\}/g))
    .map((match) => match[1].trim())
    .filter(Boolean);
}

export function validateApprovedTemplateTokens(values: string[]): string[] {
  return Array.from(
    new Set(
      values.flatMap(extractTemplateTokens).filter(
        (token) => !APPROVED_EMAIL_TEMPLATE_TOKEN_SET.has(token),
      ),
    ),
  );
}

function findRawHtmlFields({
  subject,
  bodyText,
}: {
  subject: string;
  bodyText: string;
}): Array<"subject" | "bodyText"> {
  const rawHtmlPattern = /<\/?[a-z][^>]*>/i;
  return [
    rawHtmlPattern.test(subject) ? "subject" : null,
    rawHtmlPattern.test(bodyText) ? "bodyText" : null,
  ].filter((field): field is "subject" | "bodyText" => field !== null);
}

function normalizeLinkCandidate(value: string): string {
  return value.replace(/[.;]+$/g, "");
}

export function findUnsafeTemplateLinks(values: string[]): string[] {
  const unsafe = new Set<string>();
  const linkPattern =
    /(?:[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+|mailto:[^\s<>"']+|javascript:[^\s<>"']+|data:[^\s<>"']+|vbscript:[^\s<>"']+|www\.[^\s<>"']+)/gi;

  for (const value of values) {
    const sampleRendered = value.replace(/\{\{[^{}]+\}\}/g, "sample");
    for (const match of sampleRendered.matchAll(linkPattern)) {
      const link = normalizeLinkCandidate(match[0]);
      const lower = link.toLowerCase();
      if (lower.startsWith("http://") || lower.startsWith("https://")) {
        try {
          new URL(link);
          continue;
        } catch {
          unsafe.add(link);
          continue;
        }
      }
      if (lower.startsWith("mailto:")) {
        if (!/[\r\n]/.test(link)) continue;
      }
      unsafe.add(link);
    }
  }

  return Array.from(unsafe);
}

export function validateEmailTemplateContent({
  templateName,
  subject,
  bodyText,
}: {
  templateName: string;
  subject: string;
  bodyText: string;
}): EmailTemplateValidationResult {
  const definition = getEmailTemplateDefinition(templateName);
  const issues: EmailTemplateValidationIssue[] = [];
  const values = [subject, bodyText];
  const tokens = Array.from(new Set(values.flatMap(extractTemplateTokens)));
  const unknownTokens = tokens.filter(
    (token) => !APPROVED_EMAIL_TEMPLATE_TOKEN_SET.has(token),
  );

  if (!definition) {
    issues.push({
      code: "unknown_template",
      message: "Unknown email template",
    });
  }

  if (unknownTokens.length > 0) {
    issues.push({
      code: "unknown_token",
      message: "Unknown template tokens",
      tokens: unknownTokens,
    });
  }

  const allowedTokenSet = new Set(definition?.allowedTokens ?? []);
  const disallowedTokens = definition
    ? tokens.filter((token) => !allowedTokenSet.has(token))
    : [];
  if (disallowedTokens.length > 0) {
    issues.push({
      code: "disallowed_token",
      message: "Template tokens are not allowed for this message",
      tokens: disallowedTokens,
    });
  }

  const requiredTokenSet = new Set(definition?.requiredTokens ?? []);
  const presentTokenSet = new Set(tokens);
  const missingRequiredTokens = Array.from(requiredTokenSet).filter(
    (token) => !presentTokenSet.has(token),
  );
  if (missingRequiredTokens.length > 0) {
    issues.push({
      code: "missing_required_token",
      message: "Required template tokens are missing",
      tokens: missingRequiredTokens,
    });
  }

  if (/[\r\n]/.test(subject)) {
    issues.push({
      code: "subject_line_break",
      field: "subject",
      message: "Email subjects cannot contain line breaks",
    });
  }

  for (const field of findRawHtmlFields({ subject, bodyText })) {
    issues.push({
      code: "raw_html",
      field,
      message: "Email templates must be plain text, not raw HTML",
    });
  }

  const unsafeLinks = findUnsafeTemplateLinks(values);
  if (unsafeLinks.length > 0) {
    issues.push({
      code: "unsafe_link",
      message: "Email template links must use http, https, or mailto",
      links: unsafeLinks,
    });
  }

  return {
    valid: issues.length === 0,
    issues,
    unknownTokens,
    disallowedTokens,
    missingRequiredTokens,
    unsafeLinks,
  };
}

export function renderTemplateString(
  template: string,
  data: EmailTemplateData,
): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, tokenName: string) => {
    const key = tokenName.trim();
    const value = data[key];
    if (value === null || value === undefined) return "";
    return String(value);
  });
}

async function loadTemplateOverride(
  templateName: string,
): Promise<EmailTemplateOverrideRecord | null> {
  const delegate = (prisma as unknown as {
    emailTemplateOverride?: {
      findUnique: (args: unknown) => Promise<EmailTemplateOverrideRecord | null>;
    };
  }).emailTemplateOverride;

  if (!delegate) return null;

  try {
    return await delegate.findUnique({ where: { templateName } });
  } catch {
    return null;
  }
}

export function buildEmailTemplateData(
  settings: EmailMessageSettings,
  templateData?: EmailTemplateData,
): EmailTemplateData {
  return {
    ...buildEmailTemplateGlobalData(settings),
    ...(templateData ?? {}),
  };
}

export async function prepareEmailMessage({
  templateName,
  subject,
  html,
  templateData,
}: {
  templateName: string;
  subject: string;
  html: string;
  templateData?: EmailTemplateData;
}): Promise<PreparedEmailMessage> {
  const settings = await loadEmailMessageSettings();
  const override = getEmailTemplateDefinition(templateName)
    ? await loadTemplateOverride(templateName)
    : null;
  const data = buildEmailTemplateData(settings, templateData);

  let nextSubject = subject;
  let nextHtml = html;
  let overrideApplied = false;

  if (override?.subject?.trim()) {
    nextSubject = renderTemplateString(override.subject.trim(), data);
    overrideApplied = true;
  }

  if (override?.bodyText?.trim()) {
    nextHtml = plainTextEmailTemplate(
      renderTemplateString(override.bodyText.trim(), data),
    );
    overrideApplied = true;
  }

  return {
    subject: applyEmailMessageSettingsToSubject(nextSubject, settings),
    html: applyEmailMessageSettingsToHtml(nextHtml, settings),
    settings,
    overrideApplied,
  };
}

export async function renderEmailTemplatePreview({
  subject,
  bodyText,
  templateData,
}: {
  subject: string;
  bodyText: string;
  templateData?: EmailTemplateData;
}) {
  const settings = await loadEmailMessageSettings();
  const data = buildEmailTemplateData(settings, templateData);
  const renderedSubject = applyEmailMessageSettingsToSubject(
    renderTemplateString(subject, data),
    settings,
  );
  const html = applyEmailMessageSettingsToHtml(
    plainTextEmailTemplate(renderTemplateString(bodyText, data)),
    settings,
  );

  return {
    subject: renderedSubject,
    html,
  };
}
