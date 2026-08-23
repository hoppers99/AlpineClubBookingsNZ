/**
 * The environment-safety half of the email delivery boundary (ENV-SAFETY 2,
 * #3035; epic #2986). INV-CONFIG-004.
 *
 * `sendEmail` asks this once per message, immediately before it would open a
 * transport. It exists as its own module for two reasons: `core.ts` is already
 * the longest module in the mail layer and this is a self-contained decision, and
 * keeping the EmailLog bookkeeping here means the three withhold shapes
 * (business, safety, unknown-environment) can be read side by side rather than
 * inferred from three scattered `prisma.emailLog.update` calls.
 *
 * WHAT IS WRITTEN, AND WHY THE TWO ROWS DIFFER.
 *
 * - **Confirmed NON_PRODUCTION** -> `SKIPPED_NON_PRODUCTION`, a brand-new
 *   terminal status, with the retained HTML dropped. Terminal because there is
 *   nothing to retry: a copy is a copy until somebody re-declares it, and if they
 *   do, replaying weeks of stale confirmations at real members would be worse
 *   than not sending them. Its own status rather than a reuse of
 *   `SKIPPED_NO_EMAILS`, because that value means "the club decided not to email
 *   this person about this booking" and conflating the two would make the
 *   booking's withheld list claim an admin decision nobody made — and would make
 *   the withheld-email count this issue owes #3034 uncountable.
 * - **UNKNOWN** -> `FAILED` with `deliveryBlockReason` set, and the HTML kept.
 *   Retryable on purpose, so the message goes out by itself the moment an
 *   operator declares the role — the same self-healing shape the
 *   `booking_flag_unreadable` fail-closed withhold already uses. The nullable
 *   column is what makes it distinguishable from a transport failure by something
 *   sturdier than a message string.
 *
 * NO ADMIN ALERT IS RAISED, deliberately, and this is the one place the design
 * differs from the #2258 fail-closed withhold beside it. That alert is an EMAIL,
 * so on the UNKNOWN path it would be held back by this very gate; on the
 * NON_PRODUCTION path it would mail the club's real admins from a copy, which is
 * precisely what this epic exists to stop. The unresolved state is already loud
 * where it can be acted on: the boot log, the `environment-role` setup step and
 * the Admin -> Environment panel (all #3034).
 */

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  describeDeliveryDecision,
  resolveDeliveryPolicy,
  type DeliveryBlockReason,
  type DeliveryClearance,
} from "@/lib/environment-delivery-policy";

/** How a blocked-environment reason is persisted on the mail log. */
const BLOCK_REASON_COLUMN: Record<
  DeliveryBlockReason,
  "ENVIRONMENT_DECLARATION_MISSING" | "ENVIRONMENT_DECLARATION_INVALID" | "ENVIRONMENT_OVERRIDE_UNREADABLE"
> = {
  declaration_missing: "ENVIRONMENT_DECLARATION_MISSING",
  declaration_invalid: "ENVIRONMENT_DECLARATION_INVALID",
  override_unreadable: "ENVIRONMENT_OVERRIDE_UNREADABLE",
};

export type EmailEnvironmentGate =
  | { decision: "send"; clearance: DeliveryClearance }
  | {
      decision: "withheld";
      reason: "environment_non_production" | "environment_unknown";
    };

/**
 * Decide whether this installation may transmit, and record the outcome when it
 * may not.
 *
 * `logRecipient` is whatever the caller has already decided is safe to persist —
 * `sendEmail` redacts it for the templates that must not retain an address, and
 * this module does not second-guess that.
 */
export async function resolveEmailEnvironmentGate(params: {
  emailLogId: string | null;
  templateName: string;
  logRecipient: string;
}): Promise<EmailEnvironmentGate> {
  const decision = await resolveDeliveryPolicy();
  if (decision.kind === "allow") {
    return { decision: "send", clearance: decision.clearance };
  }

  const suppressed = decision.kind === "suppress_non_production";
  const errorMessage = describeDeliveryDecision(decision);

  if (params.emailLogId) {
    try {
      await prisma.emailLog.update({
        where: { id: params.emailLogId },
        data: suppressed
          ? {
              status: "SKIPPED_NON_PRODUCTION",
              htmlBody: null,
              bookingRetryHtmlBody: null,
              errorMessage,
            }
          : {
              status: "FAILED",
              deliveryBlockReason: BLOCK_REASON_COLUMN[decision.reason],
              errorMessage,
            },
      });
    } catch (err) {
      logger.error(
        { err, to: params.logRecipient, templateName: params.templateName },
        suppressed
          ? "Failed to record an email held back because this installation is a copy"
          : "Failed to record an email held back because this installation's environment role is unknown",
      );
    }
  }

  if (suppressed) {
    logger.info(
      { to: params.logRecipient, templateName: params.templateName },
      "Held back an email: this installation is not the club's live site, so no provider was contacted",
    );
  } else {
    logger.error(
      {
        to: params.logRecipient,
        templateName: params.templateName,
        blockReason: decision.reason,
      },
      "Did not send an email: nothing has confirmed whether this installation is the club's live site or a copy, so no provider was contacted. It is queued and will go out once the environment role is declared",
    );
  }

  return {
    decision: "withheld",
    reason: suppressed ? "environment_non_production" : "environment_unknown",
  };
}
