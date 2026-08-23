/**
 * THE one place that decides what email address may reach a Xero contact, and
 * the one place that proves an existing contact has been contained (ENV-SAFETY
 * 3, #3036; epic #2986). INV-CONFIG-005.
 *
 * ## What this is for, in one paragraph
 *
 * #3035 stopped a copy of the club's site sending mail, including the three
 * places we ask Xero to email an invoice. It did not — and could not — stop XERO
 * emailing. An invoice is raised `AUTHORISED`, this issue requires it stay that
 * way so settlement behaviour remains testable on a copy, and Xero's own invoice
 * reminders go out from Xero's servers to the address stored on the contact with
 * no API call from this application at all. So on a copy the address stored on
 * the contact has to stop being a member's, and it has to stop being one BEFORE
 * an invoice exists to remind anybody about.
 *
 * ## It reads the ROLE, never the delivery policy
 *
 * `resolveDeliveryPolicy()` is right there and it is the wrong tool, so the
 * reason is written down rather than left to be rediscovered. That policy
 * carries a capture-transport carve-out: a confirmed copy whose operator has
 * declared a local capture mailbox is ALLOWED to transmit, because a capture
 * catches everything this application sends. A capture catches nothing Xero
 * sends. So a copy needs full Xero containment REGARDLESS of its transport mode,
 * and this module consumes `resolveEnvironmentRole()` (#3034, INV-CONFIG-003)
 * directly. #3035 made that structural too: `sendXeroInvoiceEmail` requires the
 * narrower `LiveProviderClearance`, so a capture clearance cannot reach it.
 *
 * ## The three answers
 *
 * - **PRODUCTION — nothing happens.** No transform, no provider read, no row
 *   written, no behaviour change of any kind. `applyXeroContactEmailPolicy` is
 *   the identity function on this branch, so every payload, every stored request
 *   payload and every idempotency key on the club's live site is byte-identical
 *   to what it was before this issue. That is the half a reviewer should check
 *   hardest and it is deliberately trivial to check.
 * - **NON_PRODUCTION — contain.** Addresses written into a contact payload are
 *   replaced by their contained form, and a contact that already exists is
 *   proved contained before its id is returned to whatever is about to invoice
 *   it.
 * - **UNKNOWN — refuse.** No transform (UNKNOWN is not evidence of being a
 *   copy, so writing a contained address over the club's real accounting on a
 *   guess is exactly as wrong as emailing real members on a guess), and no
 *   role-dependent provider side effect either. {@link
 *   resolveXeroContactEmailPolicy} throws {@link XeroContactEnvironmentUnknownError}
 *   carrying the resolver's own operator-facing notes, which name the variable
 *   to set and the screen to set it on.
 *
 * ## The clearance token, and why a type carries the guarantee
 *
 * Same shape as #3035's `DeliveryClearance`, for the same reason: a text census
 * can only see the writers that exist today. {@link applyXeroContactEmailPolicy}
 * requires a {@link XeroContactEmailPolicy}, the brand is a non-exported `unique
 * symbol` so nothing outside this module can produce a value of that type, and
 * the runtime witness is a module-private `Symbol` so the cast that defeats the
 * type (`{} as unknown as XeroContactEmailPolicy`) fails closed instead of
 * silently working. The pure decision function {@link decideXeroContactEmailPolicy}
 * MINTS NOTHING — it takes caller-supplied input, and #3035's review found that
 * a pure function which mints is a function anybody can ask for a token.
 *
 * ## Placeholder semantics stay separate
 *
 * The contained domain is never added to `PLACEHOLDER_CONTACT_EMAIL_DOMAINS`.
 * See `xero-sandbox-contact-email.ts` for the full argument; the short version is
 * that a contained member is not an unreachable member, and reporting them as
 * one would change booking flows and reminder crons on a copy, which is the
 * production-likeness this issue exists to keep.
 */

import type { XeroClient } from "xero-node";

import {
  resolveEnvironmentRole,
  type EnvironmentRole,
  type EnvironmentRoleResolution,
} from "@/lib/environment-role";
import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import {
  getAuthenticatedXeroClient,
  callXeroApi,
} from "@/lib/xero-api-client";
import {
  isXeroContactEmailUnreachable,
  toXeroSandboxContactEmail,
  xeroSandboxContainmentTarget,
} from "@/lib/xero-sandbox-contact-email";
import { buildXeroIdempotencyKey } from "@/lib/xero-sync";

/**
 * The brand. Deliberately NOT exported: a caller cannot write the property, so a
 * caller cannot write a value of this type. A `unique symbol` rather than a
 * string key, so no structurally-identical object can be assembled by accident.
 */
declare const xeroContactEmailPolicyBrand: unique symbol;

/** What the policy decided to do with a contact's email address. */
export type XeroContactEmailMode = "verbatim" | "contain";

/**
 * Proof that the environment role has been read, and permission to put an
 * address into a Xero contact payload.
 *
 * One brand for both live answers rather than two, because unlike #3035's two
 * clearances there is no path here that one answer may take and the other may
 * not: both may write a contact, and the whole difference is WHICH address gets
 * written. The mode travels inside the token and the runtime witness carries it,
 * so `applyXeroContactEmailPolicy` cannot be fooled about which one it holds.
 */
export type XeroContactEmailPolicy = {
  readonly [xeroContactEmailPolicyBrand]: XeroContactEmailMode;
};

/**
 * The runtime witness behind the compile-time brand: a module-private symbol, so
 * a forged object cannot carry it and a deserialized one cannot either — symbols
 * do not survive JSON. This is what makes the cast escape hatch fail closed.
 */
const XERO_CONTACT_POLICY_WITNESS: unique symbol = Symbol(
  "xero-contact-email-policy",
);

type MintedXeroContactEmailPolicy = {
  readonly [XERO_CONTACT_POLICY_WITNESS]: XeroContactEmailMode;
};

function mintXeroContactEmailPolicy(
  mode: XeroContactEmailMode,
): XeroContactEmailPolicy {
  // The double cast is the mint. `MintedXeroContactEmailPolicy` and the branded
  // type have no property in common by design — the brand is phantom and the
  // witness is real — so going through `unknown` here is the one place in this
  // codebase allowed to bridge them.
  const minted: MintedXeroContactEmailPolicy = {
    [XERO_CONTACT_POLICY_WITNESS]: mode,
  };
  return minted as unknown as XeroContactEmailPolicy;
}

/** Thrown when a contact-payload entry point is reached without a real policy. */
export class XeroContactEmailPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XeroContactEmailPolicyError";
  }
}

/**
 * Thrown when nothing has declared which installation this is.
 *
 * Named, and distinct from a containment failure, because the repairs are
 * different: this one is a missing or unreadable configuration and its remedy is
 * on the operator's screen, while a containment failure is a provider problem.
 * The message carries the role resolver's own notes verbatim — those are written
 * to be read by an operator, name `APP_ENVIRONMENT_ROLE` and the override
 * screen, and never carry a credential.
 */
export class XeroContactEnvironmentUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XeroContactEnvironmentUnknownError";
  }
}

/** Thrown when a copy could not prove that a contact can no longer reach a member. */
export class XeroContactContainmentError extends Error {
  readonly xeroContactId: string;

  constructor(xeroContactId: string, message: string) {
    super(message);
    this.name = "XeroContactContainmentError";
    this.xeroContactId = xeroContactId;
  }
}

/** {@link XeroContactEmailDecision} without the token. */
export type XeroContactEmailOutcome =
  | { kind: "verbatim" }
  | { kind: "contain" }
  | { kind: "block_environment_unknown" };

/** {@link XeroContactEmailOutcome} with the token the two live branches carry. */
export type XeroContactEmailDecision =
  | { kind: "verbatim"; policy: XeroContactEmailPolicy }
  | { kind: "contain"; policy: XeroContactEmailPolicy };

/**
 * The mapping from a resolved role to what may reach a Xero contact, as a pure
 * function so all three answers are assertable without a database.
 *
 * IT MINTS NOTHING — see the module docblock.
 */
export function decideXeroContactEmailPolicy(
  role: EnvironmentRole,
): XeroContactEmailOutcome {
  if (role === "PRODUCTION") return { kind: "verbatim" };
  if (role === "NON_PRODUCTION") return { kind: "contain" };
  return { kind: "block_environment_unknown" };
}

/**
 * The operator-facing refusal for an unconfirmed installation.
 *
 * It says what did NOT happen and why that is the safe direction, then hands
 * over to the resolver's own notes for the repair. Written this way because the
 * two obvious short messages are both actively misleading: "this installation is
 * not production" invites somebody to declare it production, and "Xero is not
 * configured" sends them to the Xero screens, where nothing is wrong.
 */
export function describeXeroContactEmailRefusal(
  resolution: EnvironmentRoleResolution,
): string {
  return [
    "Nothing was written to Xero: this application cannot tell whether it is " +
      "the club's live site or a copy of it, and the answer decides what email " +
      "address may go on a Xero contact. On the live site the member's real " +
      "address belongs there; on a copy it must be replaced, because Xero emails " +
      "invoice reminders from its own servers to whatever the contact holds. " +
      "Guessing either way is wrong — one emails real members from a copy, the " +
      "other rewrites the club's real accounting — so nothing was attempted.",
    ...resolution.notes,
  ].join(" ");
}

/**
 * {@link decideXeroContactEmailPolicy} over the live role, and the ONLY place a
 * policy token is minted.
 *
 * The mint sits here rather than in the pure function above because this is
 * where the role is read from its canonical resolver instead of handed in by a
 * caller. Throws on UNKNOWN rather than returning a third variant: every caller
 * of this function is a provider write and every one of them must refuse, so a
 * variant to ignore would be a variant somebody ignores.
 */
export async function resolveXeroContactEmailPolicy(): Promise<XeroContactEmailDecision> {
  const resolution = await resolveEnvironmentRole();
  const outcome = decideXeroContactEmailPolicy(resolution.role);
  if (outcome.kind === "block_environment_unknown") {
    throw new XeroContactEnvironmentUnknownError(
      describeXeroContactEmailRefusal(resolution),
    );
  }
  return { kind: outcome.kind, policy: mintXeroContactEmailPolicy(outcome.kind) };
}

/**
 * The runtime half of the guarantee: this token really was minted here.
 *
 * TypeScript's brand is erased at runtime, so `{} as unknown as
 * XeroContactEmailPolicy` type-checks. Without this check that cast would put a
 * member's real address on a copy's Xero contact — the type would be satisfied
 * and the identity branch taken. With it, the cast throws.
 *
 * Synchronous and database-free ON PURPOSE, so it is safe to call from anywhere,
 * including a payload builder running inside a short transaction. The role was
 * read microseconds earlier by {@link resolveXeroContactEmailPolicy}; this is
 * the anti-forgery check, not a second role read.
 */
export function assertXeroContactEmailPolicyWitness(
  policy: XeroContactEmailPolicy,
): XeroContactEmailMode {
  const witnessed = (
    policy as unknown as Partial<MintedXeroContactEmailPolicy> | null
  )?.[XERO_CONTACT_POLICY_WITNESS];
  if (witnessed !== "verbatim" && witnessed !== "contain") {
    throw new XeroContactEmailPolicyError(
      "Refusing to put an email address on a Xero contact: the caller did not " +
        "present a policy minted by src/lib/xero-contact-containment.ts. Call " +
        "resolveXeroContactEmailPolicy() and pass the policy it returns " +
        "(INV-CONFIG-005).",
    );
  }
  return witnessed;
}

/**
 * The address that may go into a Xero contact payload.
 *
 * On PRODUCTION this is `email` unchanged — the identity function, which is what
 * makes the live site byte-identical. On a confirmed copy it is the contained
 * form. There is no third behaviour and no way to reach this function without a
 * genuine policy.
 */
export function applyXeroContactEmailPolicy(
  policy: XeroContactEmailPolicy,
  email: string,
): string {
  return assertXeroContactEmailPolicyWitness(policy) === "verbatim"
    ? email
    : toXeroSandboxContactEmail(email);
}

/** The minimal shape of the Xero client the containment read and write need. */
type XeroContactContainmentClient = {
  accountingApi: {
    getContact: (
      tenantId: string,
      contactId: string,
    ) => Promise<{ body: { contacts?: Array<{ emailAddress?: string }> } }>;
    updateContact: (
      tenantId: string,
      contactId: string,
      contacts: { contacts: Array<{ contactID: string; emailAddress: string }> },
      idempotencyKey?: string,
    ) => Promise<{ body: unknown }>;
  };
};

/** The containment record's delegate, structurally, so a fake can stand in. */
type ContainmentDelegate = {
  findUnique: (args: {
    where: { xeroContactId: string };
    select: { containedEmail: true };
  }) => Promise<{ containedEmail: string } | null>;
  upsert: (args: {
    where: { xeroContactId: string };
    create: {
      xeroContactId: string;
      containedEmail: string;
      rewroteAddress: boolean;
    };
    update: { containedEmail: string; rewroteAddress: boolean };
  }) => Promise<unknown>;
};

function containmentDelegate(): ContainmentDelegate | undefined {
  return (
    prisma as unknown as {
      xeroSandboxContactContainment?: ContainmentDelegate;
    }
  ).xeroSandboxContactContainment;
}

/**
 * Prove that a Xero contact can no longer reach a member, before its id is
 * handed to anything that raises an invoice.
 *
 * A NO-OP ON PRODUCTION, checked from the token rather than from a second role
 * read, so the live site's contact resolution is unchanged: no evidence read, no
 * provider call, no row.
 *
 * ## The three paths, in cost order
 *
 * 1. **Durable proof already matches — zero provider calls.** One indexed
 *    primary-key-shaped read of `XeroSandboxContactContainment` by
 *    `xeroContactId`, compared against the contained address this member's
 *    CURRENT stored address maps to. This is the steady state: a batch
 *    subscription run over three hundred members costs three hundred indexed
 *    reads and no Xero traffic at all, which is what keeps this out of N+1
 *    territory. The row is one per contact, upserted, so the table cannot grow
 *    per invoice.
 * 2. **No proof, and Xero is already holding nothing deliverable.** One provider
 *    read, no write. A contact with no address, or one carrying a club-internal
 *    walk-in/deleted placeholder, can reach nobody — rewriting it would spend a
 *    provider call to change nothing.
 * 3. **No proof, and Xero is holding a real address.** One provider read and one
 *    provider write, then the row. The idempotency key is derived from the
 *    contact id and the address being written, so a retry of the same
 *    containment is the same key and cannot produce a second write; a DIFFERENT
 *    target address (the member's address moved) is a different key, which is
 *    what makes a genuine re-containment possible at all.
 *
 * ## Why it VERIFIES rather than believes, even for a contact we just created
 *
 * The create payload already carries the contained address, so a freshly created
 * contact is contained by construction and this function could record the row
 * with no provider read. It does the read anyway, and the reason is this epic's
 * own history: every serious finding in it was a record asserting something had
 * happened when it had not. A row written from "we believe we sent that" is that
 * shape. A row written after seeing Xero's stored value means *we have looked*,
 * and the cost is one extra read per newly created contact — a rare event,
 * because contacts are created once per member.
 *
 * ## Where it may run
 *
 * OUTSIDE every transaction, like every other provider call in the contact
 * layer. `findOrCreateXeroContact` and `createXeroContactForMember` call it after
 * their short advisory-locked link transactions have committed, so a slow Xero
 * cannot hold a Member row locked, and no caller of the funnel is itself inside a
 * transaction (they cannot be: the funnel opens its own). #3035 recorded the
 * matching hazard for the group-settlement path — it holds
 * `pg_advisory_xact_lock(1)` while it emails, and a second Prisma connection
 * taken in there is a pool-timeout risk because that lock is exclusive — and that
 * path resolves its contact BEFORE the fence opens, so nothing here runs inside
 * it.
 *
 * ## Failure is a refusal, never a shrug
 *
 * If containment cannot be established — the provider read fails, the write
 * fails, the row cannot be written, the delegate is missing because the migration
 * has not been applied — this throws {@link XeroContactContainmentError} and the
 * invoice does not happen. A copy that could not contain a contact and invoiced
 * anyway is precisely the outcome this issue exists to prevent.
 */
export async function ensureXeroContactContained(params: {
  policy: XeroContactEmailPolicy;
  xeroContactId: string;
  /** The member's stored address. Never written anywhere; only fingerprinted. */
  sourceEmail: string | null | undefined;
  workflow: string;
  /** Reuse an already-authenticated client where the caller has one. */
  xero?: XeroContactContainmentClient | XeroClient;
  tenantId?: string;
}): Promise<void> {
  if (assertXeroContactEmailPolicyWitness(params.policy) === "verbatim") return;

  const { xeroContactId } = params;
  const target = xeroSandboxContainmentTarget(params.sourceEmail);

  const delegate = containmentDelegate();
  if (!delegate) {
    throw new XeroContactContainmentError(
      xeroContactId,
      `This installation is a copy, so Xero contact ${xeroContactId} must not be ` +
        "left holding an address that can reach a member — and the containment " +
        "record cannot be read on this database, so containment cannot be " +
        "proved. Apply the pending migrations (prisma migrate deploy) and try " +
        "again. Nothing was written to Xero (INV-CONFIG-005).",
    );
  }

  let existing: { containedEmail: string } | null;
  try {
    existing = await delegate.findUnique({
      where: { xeroContactId },
      select: { containedEmail: true },
    });
  } catch (error) {
    throw new XeroContactContainmentError(
      xeroContactId,
      `Could not read the containment record for Xero contact ${xeroContactId}, ` +
        "so this copy cannot prove the contact is unable to reach a member. " +
        `Nothing was written to Xero. ${errorText(error)} (INV-CONFIG-005)`,
    );
  }
  if (existing?.containedEmail === target) return;

  const { xero, tenantId } = await resolveContainmentClient(params);

  let stored: string | undefined;
  try {
    const response = await callXeroApi(
      () => xero.accountingApi.getContact(tenantId, xeroContactId),
      {
        operation: "getContact",
        resourceType: "CONTACT",
        workflow: params.workflow,
        context: `containXeroContactEmail(${xeroContactId})`,
      },
    );
    stored = response.body.contacts?.[0]?.emailAddress ?? undefined;
  } catch (error) {
    throw new XeroContactContainmentError(
      xeroContactId,
      `Could not read Xero contact ${xeroContactId}, so this copy cannot prove ` +
        "the contact is unable to reach a member and will not raise anything " +
        `against it. Nothing was written to Xero. ${errorText(error)} ` +
        "(INV-CONFIG-005)",
    );
  }

  const rewroteAddress = !isXeroContactEmailUnreachable(stored);
  if (rewroteAddress) {
    /*
      The address we WRITE is derived from what Xero is holding, not from the
      member's stored address, and that distinction matters. The contact may be
      one this application merely linked — matched by email or by exact name, or
      linked wholesale by `xero-member-import.ts` — so the address on it can
      belong to somebody other than the member now pointing at it. Containing
      what is actually there is the only version that cannot leave a real address
      behind.
    */
    const contained = toXeroSandboxContactEmail(stored);
    const idempotencyKey = buildXeroIdempotencyKey(
      "contact",
      xeroContactId,
      "contain-email",
      contained,
      "v1",
    );
    try {
      await callXeroApi(
        () =>
          xero.accountingApi.updateContact(
            tenantId,
            xeroContactId,
            {
              contacts: [
                { contactID: xeroContactId, emailAddress: contained },
              ],
            },
            idempotencyKey,
          ),
        {
          operation: "updateContact",
          resourceType: "CONTACT",
          workflow: params.workflow,
          context: `containXeroContactEmail(${xeroContactId})`,
        },
      );
    } catch (error) {
      throw new XeroContactContainmentError(
        xeroContactId,
        `Could not replace the email address on Xero contact ${xeroContactId} ` +
          "with a non-deliverable one, so this copy will not raise anything " +
          "against it — the contact is still able to reach a member and Xero " +
          "would email invoice reminders to that address. " +
          `${errorText(error)} (INV-CONFIG-005)`,
      );
    }
    logger.info(
      { scope: "xero-contact-containment", xeroContactId, workflow: params.workflow },
      "This installation is a copy, so the email address on this Xero contact was replaced with a non-deliverable one. Xero can no longer email invoice reminders to a real member from here.",
    );
  }

  /*
    The address is only carried onto the ROW as the fingerprint derived from the
    member's current stored address (`target`), never as whatever was actually
    written above. They agree in the ordinary case; they differ when the contact
    was holding somebody else's address, and it is the member's address the fast
    path has to compare against next time.
  */
  await recordXeroContactContainment(delegate, {
    xeroContactId,
    containedEmail: target,
    rewroteAddress,
  });
}

/** Short, secret-free description of a caught error, for an operator message. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveContainmentClient(params: {
  xero?: XeroContactContainmentClient | XeroClient;
  tenantId?: string;
  xeroContactId: string;
}): Promise<{ xero: XeroContactContainmentClient; tenantId: string }> {
  if (params.xero && params.tenantId) {
    return {
      xero: params.xero as unknown as XeroContactContainmentClient,
      tenantId: params.tenantId,
    };
  }
  try {
    const authenticated = await getAuthenticatedXeroClient();
    return {
      xero: authenticated.xero as unknown as XeroContactContainmentClient,
      tenantId: authenticated.tenantId,
    };
  } catch (error) {
    throw new XeroContactContainmentError(
      params.xeroContactId,
      "Could not reach Xero to prove that contact " +
        `${params.xeroContactId} is unable to email a member, so this copy will ` +
        `not raise anything against it. ${errorText(error)} (INV-CONFIG-005)`,
    );
  }
}

/**
 * Write the proof.
 *
 * An upsert on the contact id, so a re-containment after a member's address
 * moves replaces the row rather than appending one. A failure here is a REFUSAL
 * and not a best-effort miss: without the row the next invoice would re-read the
 * contact from Xero, which is merely slow — but a row that cannot be written at
 * all means the database is not accepting the proof, and proceeding would leave
 * a copy invoicing on an unrecorded claim.
 */
async function recordXeroContactContainment(
  delegate: ContainmentDelegate,
  row: {
    xeroContactId: string;
    containedEmail: string;
    rewroteAddress: boolean;
  },
): Promise<void> {
  try {
    await delegate.upsert({
      where: { xeroContactId: row.xeroContactId },
      create: row,
      update: {
        containedEmail: row.containedEmail,
        rewroteAddress: row.rewroteAddress,
      },
    });
  } catch (error) {
    throw new XeroContactContainmentError(
      row.xeroContactId,
      `Xero contact ${row.xeroContactId} was contained, but the proof could not ` +
        "be recorded, so this copy cannot show that it is safe to invoice. " +
        `${errorText(error)} (INV-CONFIG-005)`,
    );
  }
}
