/**
 * THE ONLY MODULE IN THIS REPOSITORY THAT MAY CREATE A MAIL TRANSPORT
 * (ENV-SAFETY 2, #3035; epic #2986). INV-CONFIG-004.
 *
 * There are two ways out of here and they are deliberately different shapes:
 *
 * - {@link getEmailTransporter} hands back a transport that can SEND, and takes a
 *   `DeliveryClearance` to do it. The token is mintable only inside
 *   `environment-delivery-policy.ts` and only when the environment role resolved
 *   `PRODUCTION`, so a sender cannot reach a live provider without going through
 *   that policy — enforced by the type system, not by a census over the senders
 *   that happen to exist today.
 * - {@link verifyEmailTransport} proves the provider is reachable and returns a
 *   LABEL. It grants no delivery at all: no `Transporter` escapes it, so the
 *   health check and the setup wizard's provider test cannot send a message even
 *   by accident, and neither of them needs a clearance. `transporter.verify()` is
 *   still a real connection with real credentials, so it is subject to the
 *   ambiguous-configuration rule below.
 *
 * Both previously lived in four places: this module, `cron-email-retry.ts` (which
 * bypassed `sendEmail` entirely and built its own transport), `health-check.ts`
 * and the provider-test route. `email-delivery-boundary-census.test.ts` asserts
 * `nodemailer.createTransport` now appears in this file alone.
 */
import nodemailer from "nodemailer";
import {
  resolveEmailDeliveryConfig,
  type ImplicitSesDefault,
} from "@/lib/email-delivery";
import {
  requireProductionDeliveryClearance,
  type DeliveryClearance,
} from "@/lib/environment-delivery-policy";
import { getEnvironmentRole, type EnvironmentRole } from "@/lib/environment-role";

export type EmailAttachment = {
  filename: string;
  content: Buffer;
  contentType?: string;
};

let cachedTransporter: nodemailer.Transporter | null = null;
let cachedTransportSignature: string | null = null;

/**
 * The rule, written as a rule rather than as its conclusion.
 *
 * On the send path this always answers `permitted`, because a clearance means the
 * role re-resolved `PRODUCTION`. Writing `"permitted"` there as a constant would
 * be correct today and would silently stop being the rule the moment somebody
 * widened who may hold a clearance, so the role is threaded through and the
 * decision is spelled out once, here, for both callers.
 */
function implicitSesDefaultFor(role: EnvironmentRole): ImplicitSesDefault {
  return role === "PRODUCTION" ? "permitted" : "refused";
}

export async function getEmailTransporter(clearance: DeliveryClearance) {
  const role = await requireProductionDeliveryClearance(clearance);
  const config = resolveEmailDeliveryConfig(implicitSesDefaultFor(role));
  if (!config.ok || !config.transportOptions) {
    throw new Error(
      `Email delivery is not configured: ${config.issues.join("; ")}`,
    );
  }

  const signature = `${config.mode}:${config.transportOptions.host}:${config.transportOptions.port}:${config.transportOptions.auth.user}`;
  if (!cachedTransporter || cachedTransportSignature !== signature) {
    cachedTransporter = nodemailer.createTransport(config.transportOptions);
    cachedTransportSignature = signature;
  }

  return { transporter: cachedTransporter, modeLabel: config.modeLabel };
}

/**
 * Prove the configured mail provider is reachable, and return its label.
 *
 * Deliberately builds a THROWAWAY transport rather than touching the delivery
 * cache above: a diagnostic must not be able to install the connection a later
 * send reuses, and it may legitimately run under a configuration the send path
 * would refuse.
 *
 * Throws on an unusable configuration and on a failed verify, so a caller
 * reports one error shape for both. Both callers already wrap it in their own
 * timeout and error handling.
 */
export async function verifyEmailTransport(): Promise<{ modeLabel: string }> {
  const role = await getEnvironmentRole();
  const config = resolveEmailDeliveryConfig(implicitSesDefaultFor(role));
  if (!config.ok || !config.transportOptions) {
    throw new Error(
      `Email delivery config invalid: ${config.issues.join("; ")}`,
    );
  }
  const transporter = nodemailer.createTransport(config.transportOptions);
  await transporter.verify();
  return { modeLabel: config.modeLabel };
}

// Token-bearing emails should never persist their rendered HTML in logs or retry
// tables because that would retain live reset/verification links at rest.
const SENSITIVE_EMAIL_LOG_TEMPLATES = new Set([
  "password-reset",
  "admin-password-reset",
  "member-setup-invite",
  // #2034: the rendered HTML embeds a single-use /login/magic?token=<token>
  // sign-in link, so it must never persist at rest in EmailLog or the retry
  // table.
  "magic-link-login",
  "email-verification",
  "email-change-verification",
  "two-factor-code",
  "age-up-invitation",
  "nomination-request",
  "partner-invite",
  "membership-application-approved",
  "membership-cancellation-confirmation",
  "hut-leader-assignment",
  "booking-confirmed",
  "pre-arrival-reminder",
  "booking-request-verification",
  "booking-request-approved",
  "split-guest-payment-link",
  "booking-request-quote",
  "school-attendee-confirmation",
  "group-booking-join-verification",
  "chore-roster",
]);

// Failure-alert emails should also skip HTML retention so a broken admin
// mailbox or SMTP path cannot recurse into retrying the retry-failure alert.
const NON_RETRYABLE_EMAIL_LOG_TEMPLATES = new Set([
  ...SENSITIVE_EMAIL_LOG_TEMPLATES,
  // The hosting incident/outbox is the retry authority for this message. Keeping
  // a second EmailLog retry authority could replay a successful incident send.
  "hosting-coverage-lost",
  "admin-email-failure",
]);

export function shouldPersistEmailHtml(templateName: string): boolean {
  return !NON_RETRYABLE_EMAIL_LOG_TEMPLATES.has(templateName);
}
