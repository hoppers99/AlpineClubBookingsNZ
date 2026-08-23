/**
 * THE one place that decides whether this installation may contact a real member
 * (ENV-SAFETY 2, #3035; epic #2986). INV-CONFIG-004.
 *
 * Every application-controlled send — a member email through `sendEmail`, a
 * replay through the email retry cron, and the three places we ask Xero to email
 * an invoice — asks this module first, and gets one of three answers:
 *
 * - **allow** — the role resolved `PRODUCTION`. Carries a {@link DeliveryClearance},
 *   which is the only thing that opens a delivery transport or the Xero
 *   invoice-email wrapper. Live behaviour is unchanged aside from passing through
 *   here.
 * - **suppress_non_production** — the role resolved `NON_PRODUCTION`. Nothing is
 *   transmitted and no provider is contacted. This is a NORMAL, terminal outcome:
 *   a copy behaving correctly, not a fault.
 * - **block_environment_unknown** — nothing has declared which installation this
 *   is, or the safer override could not be read. Also nothing transmitted — but
 *   this IS a fault, it is recorded as retryable, and it clears itself the moment
 *   an operator declares the role.
 *
 * WHY THE THREE MUST STAY APART, since collapsing any pair is the defect this
 * issue exists to prevent. A business withhold (the booking's "No emails" switch)
 * says *the club decided not to email this person*. A safety suppression says
 * *this is not the club's live site*. An unknown-environment block says *we do
 * not know, so we are not risking it*. A provider failure says *we tried and it
 * broke*. They need four different remedies — clear the switch, nothing, declare
 * the role, retry — so an operator who cannot tell them apart cannot act on any
 * of them.
 *
 * NOTHING HERE READS THE ENVIRONMENT. It consumes `resolveEnvironmentRole()`
 * (#3034, INV-CONFIG-003) and nothing else. A second reader of the declaration
 * variable would skip the database safer override, so a copy an administrator had
 * deliberately forced safer would still be treated as the live site by that
 * caller — the split brain INV-CONFIG-003 exists to prevent.
 * `environment-role-inference-census.test.ts` fails a second reader.
 *
 * ## The clearance token, and why a type carries the guarantee
 *
 * A text census can only see the senders that exist today. The token makes the
 * rule a COMPILE-TIME one instead: `getEmailTransporter` and
 * `sendXeroInvoiceEmail` both require a `DeliveryClearance`, the type is
 * unforgeable outside this module (its brand is a non-exported `unique symbol`),
 * and this module mints one only on the `PRODUCTION` branch. So a new sender
 * cannot obtain a transport without coming through here — not because a test says
 * so, but because there is no other way to produce the argument.
 *
 * IT IS RE-ASSERTED AT RUNTIME as well, in
 * {@link requireProductionDeliveryClearance}, which every consumer calls before
 * it does anything. A cast (`{} as unknown as DeliveryClearance`) defeats the
 * type and nothing else: the runtime check refuses a token this module did not
 * mint, and then re-resolves the role and refuses anything that is not
 * `PRODUCTION`. That costs one primary-key read of a one-row table per send,
 * which is the price of the guarantee rather than an oversight — see
 * `environment-role.ts` on why that resolver is deliberately uncached.
 */

import {
  resolveEnvironmentRole,
  type EnvironmentRoleDecidedBy,
  type EnvironmentRoleResolution,
} from "@/lib/environment-role";

/**
 * The brand. Deliberately NOT exported: a caller cannot write the property, so a
 * caller cannot write a value of this type. A `unique symbol` rather than a
 * string literal key, so no structurally-identical object can be assembled by
 * accident.
 */
declare const clearanceBrand: unique symbol;

/**
 * Proof that the environment role resolved `PRODUCTION`, minted only by this
 * module and required by every delivery entry point.
 */
export type DeliveryClearance = {
  readonly [clearanceBrand]: "production-confirmed";
};

/**
 * The runtime witness behind the compile-time brand.
 *
 * A module-private symbol, so a forged object cannot carry it and a serialized
 * one cannot either — symbols do not survive JSON. This is what makes the cast
 * escape hatch fail closed instead of silently working.
 */
const CLEARANCE_WITNESS: unique symbol = Symbol("delivery-clearance");

type MintedClearance = { readonly [CLEARANCE_WITNESS]: true };

function mintClearance(): DeliveryClearance {
  // The double cast is the mint. `MintedClearance` and `DeliveryClearance` have
  // no property in common by design — the brand is phantom and the witness is
  // real — so TypeScript will not bridge them directly, and going through
  // `unknown` here is the one place in the codebase allowed to do it.
  const minted: MintedClearance = { [CLEARANCE_WITNESS]: true };
  return minted as unknown as DeliveryClearance;
}

/**
 * Why an installation's role could not be confirmed, as the three states an
 * operator has to be able to tell apart.
 *
 * Derived from the resolution's own `declaration` and `databaseOverride` — never
 * re-read from anywhere — because the repair differs: `declaration_missing`
 * means set the variable, `declaration_invalid` means fix the typo in the value
 * already set, and `override_unreadable` means the database could not answer at
 * all, which is usually a migration that has not been applied here.
 */
export type DeliveryBlockReason =
  | "declaration_missing"
  | "declaration_invalid"
  | "override_unreadable";

export type DeliveryDecision =
  | { kind: "allow"; clearance: DeliveryClearance }
  | { kind: "suppress_non_production"; decidedBy: EnvironmentRoleDecidedBy }
  | { kind: "block_environment_unknown"; reason: DeliveryBlockReason };

/**
 * The mapping from a resolved role to a delivery decision, as a pure function so
 * every combination is assertable without a database.
 *
 * THE ORDER OF THE UNKNOWN BRANCHES MATTERS, and it mirrors the resolver's own
 * precedence: an unreadable override resolves UNKNOWN even under a declared
 * `production`, so it is checked FIRST. Reading the declaration first would
 * report "you have not set the variable" to an operator who has set it correctly
 * and whose database is the actual fault — sending them to fix the one thing that
 * is already right.
 */
export function decideDeliveryPolicy(
  resolution: EnvironmentRoleResolution,
): DeliveryDecision {
  if (resolution.role === "PRODUCTION") {
    return { kind: "allow", clearance: mintClearance() };
  }
  if (resolution.role === "NON_PRODUCTION") {
    return { kind: "suppress_non_production", decidedBy: resolution.decidedBy };
  }
  if (resolution.databaseOverride.kind === "unreadable") {
    return { kind: "block_environment_unknown", reason: "override_unreadable" };
  }
  return {
    kind: "block_environment_unknown",
    reason:
      resolution.declaration.kind === "invalid"
        ? "declaration_invalid"
        : "declaration_missing",
  };
}

/** {@link decideDeliveryPolicy} over the live resolution. */
export async function resolveDeliveryPolicy(): Promise<DeliveryDecision> {
  return decideDeliveryPolicy(await resolveEnvironmentRole());
}

/**
 * Operator-facing, secret-free reason a send did not happen.
 *
 * Written for whoever reads an email log row or a Xero sync operation months
 * later, so it says what happened, what it is NOT, and what to do. It names
 * variables and screens, and never a credential, an address or a message body.
 */
export function describeDeliveryDecision(decision: DeliveryDecision): string {
  if (decision.kind === "allow") {
    return "This installation is the club's live site, so the message was delivered normally.";
  }
  if (decision.kind === "suppress_non_production") {
    return decision.decidedBy === "database-safer-override"
      ? "Held back: an administrator has switched this installation's safer override on, so it behaves as a copy and does not contact real members. Nothing was sent and no provider was contacted. Turn the override off under Admin -> Environment if this really is the club's live site."
      : "Held back: this deployment declares itself a copy (APP_ENVIRONMENT_ROLE=non-production), so it does not contact real members. Nothing was sent and no provider was contacted.";
  }
  if (decision.reason === "override_unreadable") {
    return "Not sent: this installation's environment-safety override could not be read from the database, so we cannot confirm whether this is the club's live site or a copy. Nothing was sent and no provider was contacted. Apply pending migrations (prisma migrate deploy) or restore database access; the message is queued and goes out by itself once the role can be confirmed.";
  }
  if (decision.reason === "declaration_invalid") {
    return "Not sent: APP_ENVIRONMENT_ROLE is set to a value this application refuses to interpret, so we cannot tell whether this is the club's live site or a copy. Nothing was sent and no provider was contacted. Set it to exactly production or non-production — it is not APP_RUNTIME_ROLE — and the message goes out by itself.";
  }
  return "Not sent: nothing in this deployment says whether it is the club's live site or a copy, so we will not risk emailing real members. Nothing was sent and no provider was contacted. Set APP_ENVIRONMENT_ROLE to production or non-production — it is not APP_RUNTIME_ROLE, which names the container slot — and the message goes out by itself.";
}

/** Thrown when a delivery entry point is reached without a genuine clearance. */
export class DeliveryClearanceError extends Error {}

/**
 * The cheap half of the runtime re-assert: this token really was minted here.
 *
 * WHAT IT IS FOR. TypeScript's brand is erased at runtime, so
 * `{} as unknown as DeliveryClearance` type-checks. Without this check that cast
 * would open a live provider connection — the escape hatch would work. With it
 * the cast fails closed, because the witness is a module-private symbol nobody
 * else can spell and nothing can deserialize.
 *
 * Synchronous and database-free ON PURPOSE, so it is safe to call from inside a
 * transaction holding an advisory lock. See {@link sendXeroInvoiceEmail} in
 * `xero-invoice-email.ts`, which is exactly that case.
 */
export function assertDeliveryClearanceWitness(
  clearance: DeliveryClearance,
): void {
  const witnessed =
    typeof clearance === "object" &&
    clearance !== null &&
    (clearance as unknown as Partial<MintedClearance>)[CLEARANCE_WITNESS] ===
      true;
  if (!witnessed) {
    throw new DeliveryClearanceError(
      "Refusing to open a delivery path: the caller did not present a delivery clearance minted by src/lib/environment-delivery-policy.ts. Call resolveDeliveryPolicy() and pass the clearance from its allow branch (INV-CONFIG-004).",
    );
  }
}

/**
 * Re-prove, at the moment of delivery, that this installation is production.
 *
 * BOTH CHECKS, because each catches something the other cannot: the witness
 * above catches a forged token, and re-resolving the role catches a token that
 * WAS genuine and is no longer true. An administrator can switch the safer
 * override on while a batch is mid-flight, and that click is the one somebody
 * makes when they have just realised a copy is about to email the club's real
 * members.
 *
 * The second half costs one primary-key read per call, and it is spent here
 * rather than in the Xero wrapper for a stated reason: this function guards a
 * CACHED transport that a long batch can keep reusing, while the Xero path calls
 * its provider once, immediately after a fresh resolution, from inside a
 * transaction where a second connection would be a real hazard.
 *
 * Returns the re-resolved role so its caller can state the RULE it applies rather
 * than the conclusion — see `implicitSesDefaultFor` in
 * `src/lib/email/internal.ts`.
 */
export async function requireProductionDeliveryClearance(
  clearance: DeliveryClearance,
): Promise<"PRODUCTION"> {
  assertDeliveryClearanceWitness(clearance);
  const decision = decideDeliveryPolicy(await resolveEnvironmentRole());
  if (decision.kind !== "allow") {
    throw new DeliveryClearanceError(
      `Refusing to open a delivery path: this installation is no longer confirmed production. ${describeDeliveryDecision(decision)}`,
    );
  }
  return "PRODUCTION";
}
