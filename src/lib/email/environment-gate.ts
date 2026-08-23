/**
 * The environment-safety half of the email delivery boundary (ENV-SAFETY 2,
 * #3035; epic #2986). INV-CONFIG-004.
 *
 * `sendEmail` asks this once per message, immediately before it would open a
 * transport. It exists as its own module for two reasons: `core.ts` is already
 * the longest module in the mail layer and this is a self-contained decision, and
 * keeping the EmailLog bookkeeping here means the withhold shapes can be read
 * side by side rather than inferred from scattered `prisma.emailLog.update`
 * calls.
 *
 * WHAT IS WRITTEN, AND WHY THE TWO ROWS DIFFER.
 *
 * NOTHING IS WRITTEN AT ALL for a copy that has DECLARED a local capture mailbox,
 * because nothing was withheld there: it really transmits, into a mailbox that
 * cannot deliver onward, and the row goes on to be `SENT` like any other.
 * Recording that as a withhold would be false, and would inflate the withheld
 * count the admin panel reads.
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
 * - **A capture transport on the club's LIVE site** -> `FAILED` with
 *   `deliveryBlockReason` `CAPTURE_TRANSPORT_IN_PRODUCTION`, and the HTML kept. A
 *   misconfiguration rather than an environment fact, and retryable for exactly
 *   the same reason as the row below: correct the flags and the mail goes out.
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
import type { EmailDeliveryBlockReason } from "@prisma/client";

/** How a blocked-environment reason is persisted on the mail log. */
const BLOCK_REASON_COLUMN: Record<DeliveryBlockReason, EmailDeliveryBlockReason> = {
  declaration_missing: "ENVIRONMENT_DECLARATION_MISSING",
  declaration_invalid: "ENVIRONMENT_DECLARATION_INVALID",
  override_unreadable: "ENVIRONMENT_OVERRIDE_UNREADABLE",
};

export type EmailEnvironmentGate =
  | { decision: "send"; clearance: DeliveryClearance }
  | { decision: "withheld"; reason: EmailEnvironmentWithheldReason };

/**
 * Why the boundary held a message back.
 *
 * ONE of these is terminal and the rest are faults, and that is the distinction
 * every caller keys on — see `additional-payment-resend-service.ts`, which must
 * not hand a reminder stamp back for a message the retry cron is going to replay.
 * Callers therefore test `reason !== "environment_non_production"` rather than
 * enumerating the faults, so a fault added later is replayable by default.
 */
export type EmailEnvironmentWithheldReason =
  | "environment_non_production"
  | "environment_unknown"
  | "capture_transport_in_production";

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
  const reason: EmailEnvironmentWithheldReason = suppressed
    ? "environment_non_production"
    : decision.kind === "block_capture_in_production"
      ? "capture_transport_in_production"
      : "environment_unknown";
  const blockReason: EmailDeliveryBlockReason | null =
    decision.kind === "block_capture_in_production"
      ? "CAPTURE_TRANSPORT_IN_PRODUCTION"
      : decision.kind === "block_environment_unknown"
        ? BLOCK_REASON_COLUMN[decision.reason]
        : null;

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
              deliveryBlockReason: blockReason,
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
      { to: params.logRecipient, templateName: params.templateName, blockReason },
      decision.kind === "block_capture_in_production"
        ? "Did not send an email: this deployment declares itself the club's live site AND declares a local capture mailbox, so it would accept every message and deliver none. No provider was contacted. It is queued and goes out once the transport flags are corrected"
        : "Did not send an email: nothing has confirmed whether this installation is the club's live site or a copy, so no provider was contacted. It is queued and will go out once the environment role is declared",
    );
  }

  return { decision: "withheld", reason };
}
