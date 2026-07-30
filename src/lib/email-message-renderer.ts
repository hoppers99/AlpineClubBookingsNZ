import { plainTextEmailTemplate } from "@/lib/email-templates";
import {
  applyEmailMessageSettingsToHtml,
  applyEmailMessageSettingsToSubject,
  buildEmailTemplateGlobalData,
  loadEmailMessageSettings,
  loadEmailMessageSettingsForLodge,
  type EmailMessageSettings,
} from "@/lib/email-message-settings";
import {
  APPROVED_EMAIL_TEMPLATE_TOKEN_SET,
  getSensitiveEmailSubjectTokens,
  getEmailTemplateDefinition,
} from "@/lib/email-message-registry";
import { prisma } from "@/lib/prisma";

type EmailTemplateValue = string | number | boolean | null | undefined;
export type EmailTemplateData = Record<string, EmailTemplateValue>;

interface EmailTemplateOverrideRecord {
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

interface EmailTemplateValidationIssue {
  code:
    | "unknown_template"
    | "unknown_token"
    | "disallowed_token"
    | "missing_required_token"
    | "sign_prefixed_token"
    | "sensitive_subject_token"
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
  signPrefixedTokens: string[];
  sensitiveSubjectTokens: string[];
  unsafeLinks: string[];
}

// #2267: these tokens render their own sign — "-$30.00" for a discount,
// "+$1,370.00" for a promo that raises the price — and render nothing at all
// when no promo applied. Typing a minus in front of one ("Discount:
// -{{promoAdjustment}}") re-creates the exact incident #2267 fixed: a member
// reading "Discount: -+$1,370.00" on a surcharge, or a bare "Discount: -" on a
// booking with no promo. The editor rejects it at save time instead.
const SIGN_CARRYING_TOKEN_PATTERN =
  /[-+]\s*\{\{\s*(promoAdjustment|promoSummary)\s*\}\}/g;

// #2267: plain-English copy for the required tokens whose requirement can be
// satisfied more than one way (see REQUIRED_TOKEN_ALTERNATIVES). Naming a token
// and stopping leaves an admin guessing whether their own hand-written wording
// counts, so the message says what the email must show the member and which
// tokens do that. Keyed by token name — a token name means the same thing in
// every template that supplies it.
const REQUIRED_TOKEN_GUIDANCE: Record<string, string> = {
  promoSummary:
    "this email must show members how a promo code changed their price — keep {{promoSummary}}, or show the adjustment yourself with {{promoAdjustment}} or {{discount}} (a {{subtotal}} line on its own is not an explanation)",
  doorCodeNote:
    "this email must tell members how to get into the lodge — keep {{doorCodeNote}}, or write your own label around the bare {{doorCode}} value",
};

function findSignPrefixedTokens(value: string): string[] {
  return Array.from(
    new Set(Array.from(value.matchAll(SIGN_CARRYING_TOKEN_PATTERN), (m) => m[1])),
  );
}

function extractTemplateTokens(value: string): string[] {
  return Array.from(value.matchAll(/\{\{([^{}]+)\}\}/g))
    .map((match) => match[1].trim())
    .filter(Boolean);
}

// test seam
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

function findUnsafeTemplateLinks(values: string[]): string[] {
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
  const subjectTokens = Array.from(new Set(extractTemplateTokens(subject)));
  const bodyTokens = Array.from(new Set(extractTemplateTokens(bodyText)));
  const tokens = Array.from(new Set([...subjectTokens, ...bodyTokens]));
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

  // Required tokens are body content (door codes, credential links), so they
  // must be present in the body itself — a token in the subject does not
  // satisfy the requirement. An empty body override falls back to the default
  // body, which already carries the required tokens, so it is not checked.
  // A required token may also be satisfied by a registered alternative that
  // carries the same information (#2267): the booking-confirmed body now uses
  // the pre-composed {{doorCodeNote}}, but an override saved earlier writes
  // its own "Door code: {{doorCode}}" line and must stay valid and re-savable.
  const requiredTokenSet = new Set(definition?.requiredTokens ?? []);
  const requiredTokenAlternatives = definition?.requiredTokenAlternatives ?? {};
  const bodyTokenSet = new Set(bodyTokens);
  const missingRequiredTokens =
    bodyText.trim().length > 0
      ? Array.from(requiredTokenSet).filter(
          (token) =>
            !bodyTokenSet.has(token) &&
            !(requiredTokenAlternatives[token] ?? []).some((alternative) =>
              bodyTokenSet.has(alternative),
            ),
        )
      : [];
  if (missingRequiredTokens.length > 0) {
    const guidance = missingRequiredTokens
      .map((token) => REQUIRED_TOKEN_GUIDANCE[token])
      .filter((entry): entry is string => Boolean(entry));
    issues.push({
      code: "missing_required_token",
      message:
        guidance.length > 0
          ? `Required template tokens are missing from the body: ${guidance.join("; ")}`
          : "Required template tokens are missing from the body",
      tokens: missingRequiredTokens,
    });
  }

  const signPrefixedByField = {
    subject: findSignPrefixedTokens(subject),
    bodyText: findSignPrefixedTokens(bodyText),
  };
  const signPrefixedTokens = Array.from(
    new Set([...signPrefixedByField.subject, ...signPrefixedByField.bodyText]),
  );
  for (const field of ["subject", "bodyText"] as const) {
    const fieldTokens = signPrefixedByField[field];
    if (fieldTokens.length > 0) {
      issues.push({
        code: "sign_prefixed_token",
        field,
        message:
          "Remove the plus or minus you typed in front of this token. It already includes its own sign — a discount reads -$30.00 and a promo that raises the price reads +$1,370.00 — and it renders nothing at all when no promo applied, so a sign of your own would leave a stray + or - in the email",
        tokens: fieldTokens,
      });
    }
  }

  // Subjects are persisted in EmailLog and travel in clear mail headers, so
  // secret-bearing tokens are never allowed in a subject line.
  const sensitiveSubjectTokenSet = getSensitiveEmailSubjectTokens(templateName);
  const sensitiveSubjectTokens = subjectTokens.filter((token) =>
    sensitiveSubjectTokenSet.has(token),
  );
  if (sensitiveSubjectTokens.length > 0) {
    issues.push({
      code: "sensitive_subject_token",
      field: "subject",
      message:
        "Sensitive tokens such as door codes and credential links cannot be used in email subjects",
      tokens: sensitiveSubjectTokens,
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
    signPrefixedTokens,
    sensitiveSubjectTokens,
    unsafeLinks,
  };
}

// test seam
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

// Defence in depth for subject rendering: even if a stored override slips a
// sensitive token into a subject (for example a row saved before save-time
// validation existed), the live value must never reach the subject, because
// EmailLog persists subjects for every template and mail headers travel in
// the clear.
function buildSubjectSafeTemplateData(
  data: EmailTemplateData,
  templateName?: string,
): EmailTemplateData {
  const sensitiveSubjectTokenSet = getSensitiveEmailSubjectTokens(templateName);
  const safe: EmailTemplateData = {};
  for (const [key, value] of Object.entries(data)) {
    if (!sensitiveSubjectTokenSet.has(key)) safe[key] = value;
  }
  return safe;
}

// Minimum length for the literal-value scrub below; shorter strings are too
// likely to collide with legitimate subject text, and they can never be
// template-substituted into a subject because of buildSubjectSafeTemplateData.
const SENSITIVE_SUBJECT_VALUE_MIN_LENGTH = 3;

// test seam
export function neutraliseSensitiveSubjectContent(
  subject: string,
  data: EmailTemplateData,
  templateName?: string,
): string {
  const sensitiveSubjectTokenSet = getSensitiveEmailSubjectTokens(templateName);
  // The alternation is built from a fixed internal token set, not user input; the
  // tokens are simple {{name}} identifiers with no ReDoS structure.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const sensitiveSubjectTokenPattern = new RegExp(
    `\\{\\{\\s*(?:${Array.from(sensitiveSubjectTokenSet).join("|")})\\s*\\}\\}`,
    "g",
  );
  let result = subject.replace(sensitiveSubjectTokenPattern, "");
  // Last-resort scrub: drop any live sensitive value that somehow reached the
  // subject string through a non-template path.
  for (const token of sensitiveSubjectTokenSet) {
    const value = data[token];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length < SENSITIVE_SUBJECT_VALUE_MIN_LENGTH) continue;
    result = result.split(trimmed).join("");
  }
  if (result === subject) return subject;
  return result.replace(/\s{2,}/g, " ").trim();
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

function buildEmailTemplateData(
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
  lodgeId,
}: {
  templateName: string;
  subject: string;
  html: string;
  templateData?: EmailTemplateData;
  // Lodge whose identity (name, travel note, door code) this message carries
  // (multi-lodge phase 8). Omitted/null resolves the default lodge identity.
  lodgeId?: string | null;
}): Promise<PreparedEmailMessage> {
  const settings = await loadEmailMessageSettingsForLodge(lodgeId);
  const override = getEmailTemplateDefinition(templateName)
    ? await loadTemplateOverride(templateName)
    : null;
  const data = buildEmailTemplateData(settings, templateData);

  let nextSubject = subject;
  let nextHtml = html;
  let overrideApplied = false;

  if (override?.subject?.trim()) {
    // Subjects render without sensitive values so a stored override can never
    // substitute a door code or credential link into the subject line.
    nextSubject = renderTemplateString(
      override.subject.trim(),
      buildSubjectSafeTemplateData(data, templateName),
    );
    overrideApplied = true;
  }

  if (override?.bodyText?.trim()) {
    nextHtml = plainTextEmailTemplate(
      renderTemplateString(override.bodyText.trim(), data),
    );
    overrideApplied = true;
  }

  return {
    subject: applyEmailMessageSettingsToSubject(
      neutraliseSensitiveSubjectContent(nextSubject, data, templateName),
      settings,
    ),
    html: applyEmailMessageSettingsToHtml(nextHtml, settings),
    settings,
    overrideApplied,
  };
}

export async function renderEmailTemplatePreview({
  templateName,
  subject,
  bodyText,
  templateData,
}: {
  templateName: string;
  subject: string;
  bodyText: string;
  templateData?: EmailTemplateData;
}) {
  const settings = await loadEmailMessageSettings();
  const data = buildEmailTemplateData(settings, templateData);
  // Preview subjects render with the same sensitive-token stripping as real
  // sends so the admin preview matches delivered mail.
  const renderedSubject = applyEmailMessageSettingsToSubject(
    neutraliseSensitiveSubjectContent(
      renderTemplateString(
        subject,
        buildSubjectSafeTemplateData(data, templateName),
      ),
      data,
      templateName,
    ),
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
