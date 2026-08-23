/**
 * THE ONLY PLACE THAT ASKS XERO TO EMAIL AN INVOICE (ENV-SAFETY 2, #3035; epic
 * #2986). INV-CONFIG-004.
 *
 * Three workflows raise an invoice and then ask Xero to send it to the member —
 * booking Internet Banking payments, group-settlement invoices and membership
 * subscription invoices. Every one of them is a provider send to a real member's
 * real address, and none of them goes anywhere near `sendEmail`, so the delivery
 * boundary has to cover them explicitly.
 *
 * The provider call lives here and nowhere else. That is enforced twice:
 * {@link sendXeroInvoiceEmail} requires a `DeliveryClearance`, which only
 * `environment-delivery-policy.ts` can mint and only on the `PRODUCTION` branch,
 * and `email-delivery-boundary-census.test.ts` asserts at source level that the
 * text `accountingApi.emailInvoice(` appears in this file alone.
 *
 * ## What the callers must do with a non-allow answer, and what they must NOT
 *
 * WHAT IS NOT SENT IS THE ONLY THING THAT CHANGES. The invoice is already raised
 * in Xero and stays `AUTHORISED`; no booking, payment, charge or invoice business
 * state may be moved as though the provider had failed. In particular:
 *
 * - **A safety suppression is not an error.** It must not populate the
 *   `invoiceEmailError` that makes a sync operation `PARTIAL`, and it must not
 *   write a subscription charge to `EMAIL_FAILED`. Nothing failed: the invoice
 *   exists and we deliberately did not email it.
 * - **A safety suppression is not the club's "No emails" decision either.** It
 *   must not write a withheld-booking-email audit row, because that row means an
 *   administrator turned the switch on for that booking and it renders on the
 *   booking page as exactly that claim.
 * - **An UNKNOWN role IS a fault**, and reuses the shape the existing
 *   unreadable-switch case already established: no audit row, a populated
 *   `invoiceEmailError` so the sync operation completes `PARTIAL` and stays
 *   visible to an operator, and no business-state change. It clears itself when
 *   the role is declared only in the sense that the operation is visible and can
 *   be re-driven or the invoice sent from Xero by hand — see the note on
 *   re-drives in each caller.
 */

import { RequestEmpty } from "xero-node";

import { callXeroApi } from "@/lib/xero-api-client";
import {
  assertDeliveryClearanceWitness,
  describeDeliveryDecision,
  resolveDeliveryPolicy,
  type DeliveryClearance,
  type DeliveryDecision,
} from "@/lib/environment-delivery-policy";

/**
 * The narrowest shape of the Xero client this module needs.
 *
 * Structural rather than the `XeroClient` type, so a caller cannot be forced to
 * widen what it holds and a test does not have to build a whole client to
 * exercise the boundary.
 */
export type XeroInvoiceEmailClient = {
  accountingApi: {
    emailInvoice: (
      tenantId: string,
      invoiceId: string,
      requestEmpty: RequestEmpty,
      idempotencyKey?: string,
    ) => Promise<{ body?: unknown }>;
  };
};

/**
 * Ask the environment-safety policy whether this installation may have Xero email
 * a member.
 *
 * Exposed separately from the send so a caller can ask BEFORE it enters a
 * transaction or takes an advisory lock. The group-settlement workflow needs
 * exactly that: its `emailInvoice` call is the one deliberately
 * provider-spanning fence inside `pg_advisory_xact_lock(1)`, and resolving the
 * role in there would open a second database connection while that lock is held.
 */
export async function resolveXeroInvoiceEmailPolicy(): Promise<DeliveryDecision> {
  return resolveDeliveryPolicy();
}

/**
 * What a caller must do about a non-allow decision, decided ONCE here so all
 * three invoice workflows behave identically.
 *
 * `error` is the whole rule in one field. A confirmed copy gets `null`: nothing
 * failed, so nothing may populate the `invoiceEmailError` that turns a sync
 * operation `PARTIAL`, and a staging run that reported PARTIAL on every invoice
 * would train an operator to ignore PARTIAL. An unconfirmed role gets a real
 * `Error`, because an invoice went out unemailed and somebody has to see that.
 *
 * `logMessage` is deliberately context-free — the caller's log object already
 * carries the booking, settlement or charge id — so the wording cannot drift
 * between the three sites.
 */
export type XeroInvoiceEmailWithheld = {
  suppressedForNonProduction: boolean;
  error: Error | null;
  logMessage: string;
};

export function classifyXeroInvoiceEmailWithheld(
  decision: Exclude<DeliveryDecision, { kind: "allow" }>,
): XeroInvoiceEmailWithheld {
  const detail = describeDeliveryDecision(decision);
  if (decision.kind === "suppress_non_production") {
    return {
      suppressedForNonProduction: true,
      error: null,
      logMessage: `Did not ask Xero to email this invoice. The invoice is raised in Xero and untouched. ${detail}`,
    };
  }
  return {
    suppressedForNonProduction: false,
    error: new Error(detail),
    logMessage: `Did not ask Xero to email this invoice, and the sync operation is marked PARTIAL so the unemailed invoice stays visible. ${detail}`,
  };
}

/**
 * The provider call, gated on a clearance.
 *
 * Metered and retried through `callXeroApi` exactly as the three call sites did
 * before, and the idempotency key still comes from the caller — a per-invoice key
 * is what makes a re-drive a no-op rather than a second email.
 *
 * THE RUNTIME CHECK HERE IS THE WITNESS ONLY, not a second role read, and the
 * reason is stated rather than left as an inconsistency with
 * `getEmailTransporter`. A clearance reaches this function microseconds after
 * {@link resolveXeroInvoiceEmailPolicy} read the database for it, and the
 * group-settlement caller is inside `pg_advisory_xact_lock(1)` when it calls —
 * where a second Prisma connection is a genuine hazard, because that lock is
 * exclusive, so every other invoice run is queued behind it holding a connection
 * of its own. The witness check needs no connection and is what closes the cast
 * escape hatch, which is the part a type cannot defend.
 */
export async function sendXeroInvoiceEmail(params: {
  clearance: DeliveryClearance;
  xero: XeroInvoiceEmailClient;
  tenantId: string;
  invoiceId: string;
  idempotencyKey: string;
  workflow: string;
  context: string;
}): Promise<{ body: unknown }> {
  assertDeliveryClearanceWitness(params.clearance);
  const response = await callXeroApi(
    () =>
      params.xero.accountingApi.emailInvoice(
        params.tenantId,
        params.invoiceId,
        new RequestEmpty(),
        params.idempotencyKey,
      ),
    {
      operation: "emailInvoice",
      resourceType: "INVOICE",
      workflow: params.workflow,
      context: params.context,
    },
  );
  return { body: response.body ?? null };
}
