import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { DELETED_CONTACT_EMAIL_DOMAIN } from "@/lib/placeholder-contact-email";
import { buildXeroContactUrl } from "@/lib/xero-links";
import {
  completeXeroSyncOperation,
  upsertXeroObjectLink,
} from "@/lib/xero-sync";

type ContactCreateRecoveryDb = Pick<
  Prisma.TransactionClient,
  "xeroSyncOperation"
>;

type ManualContactLinkFenceDb = Pick<
  Prisma.TransactionClient,
  "$executeRaw" | "member" | "xeroSyncOperation"
>;

type ContactLinkMemberFenceDb = Pick<
  Prisma.TransactionClient,
  "$executeRaw" | "member"
>;

export type InboundMemberContactPatch = {
  dateOfBirth?: Date | null;
  joinedDate?: Date | null;
  phoneCountryCode?: string | null;
  phoneAreaCode?: string | null;
  phoneNumber?: string | null;
  streetAddressLine1?: string | null;
  streetAddressLine2?: string | null;
  streetCity?: string | null;
  streetRegion?: string | null;
  streetPostalCode?: string | null;
  streetCountry?: string | null;
  postalAddressLine1?: string | null;
  postalAddressLine2?: string | null;
  postalCity?: string | null;
  postalRegion?: string | null;
  postalPostalCode?: string | null;
  postalCountry?: string | null;
};

type InboundMemberContactUpdateData = InboundMemberContactPatch & {
  xeroContactId?: string;
};

export const XERO_CONTACT_CREATE_LOCAL_LINK_FAILURE_PHASE =
  "local_link_after_xero_resolution";
export const XERO_CONTACT_CREATE_PROVIDER_CREATED_PENDING_LINK_PHASE =
  "provider_contact_created_local_link_pending";
export const XERO_CONTACT_CREATE_STALE_RUNNING_ERROR_CODE =
  "ORPHANED_STALE_RUNNING";
export const XERO_CONTACT_CREATE_IN_PROGRESS_CODE =
  "XERO_CONTACT_CREATE_IN_PROGRESS";
export const XERO_CONTACT_CREATE_IN_PROGRESS_MESSAGE =
  "A Xero contact create is still in progress or awaiting recovery. Refresh this member before taking another Xero action.";
export const XERO_MEMBER_UNAVAILABLE_CODE = "XERO_MEMBER_UNAVAILABLE";
export const XERO_MEMBER_UNAVAILABLE_MESSAGE =
  "This member account is no longer available for Xero contact changes. Refresh the member and do not retry this action.";
export const XERO_CONTACT_LINK_CHANGED_CODE = "XERO_CONTACT_LINK_CHANGED";
export const XERO_CONTACT_LINK_CHANGED_MESSAGE =
  "This member's Xero contact link changed before the update could run. Refresh the member and do not retry the stale action.";
export const XERO_CONTACT_CREATE_BLOCKS_DELETION_CODE =
  "XERO_CONTACT_CREATE_BLOCKS_DELETION";
export const XERO_CONTACT_CREATE_BLOCKS_DELETION_MESSAGE =
  "Account deletion was not completed because a Xero contact change is still in progress or awaiting recovery. Resolve that Xero operation, then retry the remaining deletion cleanup.";
export const DELETED_ACCOUNT_PASSWORD_HASH = "DELETED_ACCOUNT";

export class XeroContactCreateInProgressError extends Error {
  readonly code = XERO_CONTACT_CREATE_IN_PROGRESS_CODE;
  readonly statusCode = 409;

  constructor() {
    super(XERO_CONTACT_CREATE_IN_PROGRESS_MESSAGE);
    this.name = "XeroContactCreateInProgressError";
  }
}

export class XeroContactAlreadyLinkedError extends Error {
  readonly code = "XERO_CONTACT_ALREADY_LINKED";
  readonly statusCode = 409;

  constructor() {
    super("Member already linked to Xero");
    this.name = "XeroContactAlreadyLinkedError";
  }
}

export class XeroMemberUnavailableError extends Error {
  readonly code = XERO_MEMBER_UNAVAILABLE_CODE;
  readonly statusCode = 409;

  constructor() {
    super(XERO_MEMBER_UNAVAILABLE_MESSAGE);
    this.name = "XeroMemberUnavailableError";
  }
}

export class XeroContactLinkChangedError extends Error {
  readonly code = XERO_CONTACT_LINK_CHANGED_CODE;
  readonly statusCode = 409;

  constructor() {
    super(XERO_CONTACT_LINK_CHANGED_MESSAGE);
    this.name = "XeroContactLinkChangedError";
  }
}

export class XeroContactCreateBlocksDeletionError extends Error {
  readonly code = XERO_CONTACT_CREATE_BLOCKS_DELETION_CODE;
  readonly statusCode = 409;

  constructor() {
    super(XERO_CONTACT_CREATE_BLOCKS_DELETION_MESSAGE);
    this.name = "XeroContactCreateBlocksDeletionError";
  }
}

export type MemberContactCreateRecoveryState =
  | "CREATE_IN_PROGRESS"
  | "PROVIDER_CREATED_LINK_PENDING";

const contactCreateIdentityWhere = (memberId: string) => ({
  direction: "OUTBOUND",
  entityType: "CONTACT",
  operationType: "CREATE",
  localModel: "Member",
  localId: memberId,
  manuallyResolvedAt: null,
}) satisfies Prisma.XeroSyncOperationWhereInput;

const providerCreatedPayloadWhere = (phase: string) => [
  {
    responsePayload: {
      path: ["phase"],
      equals: phase,
    },
  },
  {
    responsePayload: {
      path: ["providerContactCreated"],
      equals: true,
    },
  },
] satisfies Prisma.XeroSyncOperationWhereInput[];

export function ambiguousMemberContactCreateReservationWhere(
  memberId: string,
): Prisma.XeroSyncOperationWhereInput {
  return {
    ...contactCreateIdentityWhere(memberId),
    OR: [
      { status: "RUNNING" },
      {
        status: "FAILED",
        lastErrorCode: XERO_CONTACT_CREATE_STALE_RUNNING_ERROR_CODE,
      },
    ],
  };
}

export function isDeletedAccountMarker(member: {
  email: string;
  passwordHash?: string | null;
}): boolean {
  // The persisted column is non-null. The fallback keeps older unit fixtures
  // that intentionally project only the fields under test from masquerading
  // as a deleted account; production reads always select the real email.
  const email = (member.email ?? "").trim().toLowerCase();
  return (
    member.passwordHash === DELETED_ACCOUNT_PASSWORD_HASH ||
    email.endsWith(`@${DELETED_CONTACT_EMAIL_DOMAIN}`)
  );
}

export function assertMemberAvailableForXeroContactChange(member: {
  email: string;
  passwordHash?: string | null;
}): void {
  if (isDeletedAccountMarker(member)) {
    throw new XeroMemberUnavailableError();
  }
}

/**
 * Take the exact Member row before any local Xero contact link is written.
 * Account deletion takes the same row FOR UPDATE, so either it commits first
 * and this writer observes the canonical anonymisation marker, or this short
 * local-link transaction commits before deletion can continue.
 */
export async function lockMemberForXeroContactLink(
  db: ContactLinkMemberFenceDb,
  memberId: string,
) {
  const locked = await db.$executeRaw`
    SELECT 1
    FROM "Member"
    WHERE "id" = ${memberId}
    FOR UPDATE
  `;
  if (locked !== 1) {
    throw new Error(`Member not found: ${memberId}`);
  }

  const member = await db.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      email: true,
      passwordHash: true,
      xeroContactId: true,
    },
  });
  if (!member) {
    throw new Error(`Member not found: ${memberId}`);
  }
  assertMemberAvailableForXeroContactChange(member);
  return member;
}

/**
 * Close any member-scoped operation that would write a canonical CONTACT link
 * under the same row fence as merge and deletion. The operation need not be a
 * CONTACT UPDATE (managed contact-group sync also refreshes this link), so the
 * lifecycle guarantee belongs at the link-completion boundary.
 */
export async function completeMemberContactOperation(
  memberId: string,
  expectedXeroContactId: string,
  operationId: string,
  completion: Parameters<typeof completeXeroSyncOperation>[1],
  db: typeof prisma = prisma,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const locked = await lockMemberForXeroContactLink(tx, memberId);
    if (locked.xeroContactId !== expectedXeroContactId) {
      throw new XeroContactLinkChangedError();
    }
    await completeXeroSyncOperation(operationId, completion, { store: tx });
  });
}

/**
 * Apply an inbound Xero contact backfill under the same Member-row privacy
 * fence as outbound completion and manual linking.
 *
 * The candidate values may have been fetched from Xero well before this short
 * transaction starts. Nothing is copied until the target row is locked and
 * re-read: deletion-first observes the canonical deleted marker, merge-first
 * observes a missing loser, and a concurrent relink is rejected. Blank-field
 * predicates are re-evaluated under that lock so an inbound replay cannot
 * overwrite a newer local edit. The pointer and FK-less CONTACT ledger row are
 * committed together; callers must not write either one separately afterward.
 */
export async function applyInboundMemberContactPatch(
  input: {
    memberId: string;
    xeroContactId: string;
    patch?: InboundMemberContactPatch;
    setCanonicalLink?: boolean;
  },
  db: typeof prisma = prisma,
): Promise<{
  appliedFields: string[];
  linked: boolean;
}> {
  return db.$transaction(async (tx) => {
    const lockedLink = await lockMemberForXeroContactLink(tx, input.memberId);
    if (
      lockedLink.xeroContactId &&
      lockedLink.xeroContactId !== input.xeroContactId
    ) {
      throw new XeroContactLinkChangedError();
    }

    const current = await tx.member.findUnique({
      where: { id: input.memberId },
      select: {
        id: true,
        xeroContactId: true,
        dateOfBirth: true,
        joinedDate: true,
        phoneNumber: true,
        streetAddressLine1: true,
        postalAddressLine1: true,
      },
    });
    if (!current) {
      throw new Error(`Member not found: ${input.memberId}`);
    }

    const candidate = input.patch ?? {};
    const data: InboundMemberContactUpdateData = {};
    const appliedFields: string[] = [];
    const linked =
      input.setCanonicalLink !== false && current.xeroContactId === null;
    if (linked) {
      data.xeroContactId = input.xeroContactId;
      appliedFields.push("xeroContactId");
    }
    if (!current.dateOfBirth && candidate.dateOfBirth) {
      data.dateOfBirth = candidate.dateOfBirth;
      appliedFields.push("dateOfBirth");
    }
    if (!current.joinedDate && candidate.joinedDate) {
      data.joinedDate = candidate.joinedDate;
      appliedFields.push("joinedDate");
    }
    if (!current.phoneNumber && candidate.phoneNumber) {
      data.phoneCountryCode = candidate.phoneCountryCode ?? null;
      data.phoneAreaCode = candidate.phoneAreaCode ?? null;
      data.phoneNumber = candidate.phoneNumber;
      appliedFields.push("phoneCountryCode", "phoneAreaCode", "phoneNumber");
    }
    if (!current.streetAddressLine1 && candidate.streetAddressLine1) {
      data.streetAddressLine1 = candidate.streetAddressLine1;
      data.streetAddressLine2 = candidate.streetAddressLine2 ?? null;
      data.streetCity = candidate.streetCity ?? null;
      data.streetRegion = candidate.streetRegion ?? null;
      data.streetPostalCode = candidate.streetPostalCode ?? null;
      data.streetCountry = candidate.streetCountry ?? null;
      appliedFields.push(
        "streetAddressLine1",
        "streetAddressLine2",
        "streetCity",
        "streetRegion",
        "streetPostalCode",
        "streetCountry",
      );
    }
    if (!current.postalAddressLine1 && candidate.postalAddressLine1) {
      data.postalAddressLine1 = candidate.postalAddressLine1;
      data.postalAddressLine2 = candidate.postalAddressLine2 ?? null;
      data.postalCity = candidate.postalCity ?? null;
      data.postalRegion = candidate.postalRegion ?? null;
      data.postalPostalCode = candidate.postalPostalCode ?? null;
      data.postalCountry = candidate.postalCountry ?? null;
      appliedFields.push(
        "postalAddressLine1",
        "postalAddressLine2",
        "postalCity",
        "postalRegion",
        "postalPostalCode",
        "postalCountry",
      );
    }

    if (appliedFields.length > 0) {
      await tx.member.update({
        where: { id: input.memberId },
        data,
        select: { id: true },
      });
    }
    await upsertXeroObjectLink(
      {
        localModel: "Member",
        localId: input.memberId,
        xeroObjectType: "CONTACT",
        xeroObjectId: input.xeroContactId,
        xeroObjectUrl: buildXeroContactUrl(input.xeroContactId),
        role: "CONTACT",
      },
      { store: tx },
    );

    return { appliedFields, linked };
  });
}

/**
 * Fence a manual Xero link against an ambiguous provider create.
 *
 * Provider contact verification happens before the caller's short transaction.
 * Inside it, this exact target Member row is the first lock. The active create
 * reservation is then re-read under that lock, so either the reservation wins
 * and manual linking refuses, or the manual link commits before a later create
 * reservation can re-read the authoritative `xeroContactId`.
 */
export async function lockMemberForManualXeroContactLink(
  db: ManualContactLinkFenceDb,
  memberId: string,
): Promise<void> {
  await lockMemberForXeroContactLink(db, memberId);

  const activeCreate = await db.xeroSyncOperation.findFirst({
    where: ambiguousMemberContactCreateReservationWhere(memberId),
    select: { id: true },
  });
  if (activeCreate) {
    throw new XeroContactCreateInProgressError();
  }
}

export function unresolvedMemberContactCreateRecoveryWhere(
  memberId: string,
): Prisma.XeroSyncOperationWhereInput {
  return {
    ...contactCreateIdentityWhere(memberId),
    OR: [
      {
        status: "FAILED",
        AND: providerCreatedPayloadWhere(
          XERO_CONTACT_CREATE_LOCAL_LINK_FAILURE_PHASE,
        ),
      },
      {
        status: { in: ["RUNNING", "FAILED"] },
        AND: providerCreatedPayloadWhere(
          XERO_CONTACT_CREATE_PROVIDER_CREATED_PENDING_LINK_PHASE,
        ),
      },
    ],
  };
}

export function memberContactCreateMergeBlockerWhere(
  memberId: string,
): Prisma.XeroSyncOperationWhereInput {
  return {
    ...contactCreateIdentityWhere(memberId),
    OR: [
      { status: "RUNNING" },
      {
        status: "FAILED",
        lastErrorCode: XERO_CONTACT_CREATE_STALE_RUNNING_ERROR_CODE,
      },
      {
        status: "FAILED",
        OR: [
          {
            AND: providerCreatedPayloadWhere(
              XERO_CONTACT_CREATE_LOCAL_LINK_FAILURE_PHASE,
            ),
          },
          {
            AND: providerCreatedPayloadWhere(
              XERO_CONTACT_CREATE_PROVIDER_CREATED_PENDING_LINK_PHASE,
            ),
          },
        ],
      },
    ],
  };
}

/**
 * Exact provider-work reservations that must keep the participant Member row
 * alive. CREATE additionally carries durable provider-created recovery states;
 * UPDATE only blocks while RUNNING because provider failure closes the attempt
 * before a retry may reserve again from current Member data.
 */
export function memberContactChangeMergeBlockerWhere(
  memberId: string,
): Prisma.XeroSyncOperationWhereInput {
  return {
    direction: "OUTBOUND",
    entityType: "CONTACT",
    localModel: "Member",
    localId: memberId,
    manuallyResolvedAt: null,
    OR: [
      {
        operationType: "UPDATE",
        status: "RUNNING",
      },
      {
        operationType: "CREATE",
        OR: memberContactCreateMergeBlockerWhere(memberId).OR,
      },
    ],
  };
}

export function isProviderCreatedLocalLinkFailurePayload(
  payload: unknown,
): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const record = payload as Record<string, unknown>;
  return (
    (record.phase === XERO_CONTACT_CREATE_LOCAL_LINK_FAILURE_PHASE ||
      record.phase ===
        XERO_CONTACT_CREATE_PROVIDER_CREATED_PENDING_LINK_PHASE) &&
    record.providerContactCreated === true
  );
}

export async function recordProviderCreatedContactPendingLocalLink(params: {
  operationId: string;
  resolvedContactId: string;
  db?: ContactCreateRecoveryDb;
}): Promise<void> {
  const db = params.db ?? prisma;
  const updated = await db.xeroSyncOperation.updateMany({
    where: {
      id: params.operationId,
      status: "RUNNING",
      manuallyResolvedAt: null,
    },
    data: {
      responsePayload: {
        phase: XERO_CONTACT_CREATE_PROVIDER_CREATED_PENDING_LINK_PHASE,
        providerContactCreated: true,
        resolvedContactId: params.resolvedContactId,
      },
      xeroObjectType: "CONTACT",
      xeroObjectId: params.resolvedContactId,
    },
  });
  if (updated.count !== 1) {
    throw new Error(
      `Could not record provider-created Xero contact for operation ${params.operationId}`,
    );
  }
}

export async function hasUnresolvedMemberContactCreateRecovery(
  memberId: string,
  db: ContactCreateRecoveryDb = prisma,
): Promise<boolean> {
  const operation = await db.xeroSyncOperation.findFirst({
    where: unresolvedMemberContactCreateRecoveryWhere(memberId),
    select: { id: true, responsePayload: true },
  });
  return (
    operation !== null &&
    isProviderCreatedLocalLinkFailurePayload(operation.responsePayload)
  );
}

export async function hasMemberContactCreateMergeBlocker(
  memberId: string,
  db: ContactCreateRecoveryDb = prisma,
): Promise<boolean> {
  const operation = await db.xeroSyncOperation.findFirst({
    where: memberContactCreateMergeBlockerWhere(memberId),
    select: {
      id: true,
      status: true,
      lastErrorCode: true,
      responsePayload: true,
    },
  });
  return (
    operation !== null &&
    (operation.status === "RUNNING" ||
      (operation.status === "FAILED" &&
        operation.lastErrorCode ===
          XERO_CONTACT_CREATE_STALE_RUNNING_ERROR_CODE) ||
      isProviderCreatedLocalLinkFailurePayload(operation.responsePayload))
  );
}

export async function hasMemberContactChangeMergeBlocker(
  memberId: string,
  db: ContactCreateRecoveryDb = prisma,
): Promise<boolean> {
  const operation = await db.xeroSyncOperation.findFirst({
    where: memberContactChangeMergeBlockerWhere(memberId),
    select: { id: true },
  });
  return operation !== null;
}

/**
 * Account deletion calls this only after its standing fan-out has taken the
 * target Member FOR UPDATE. The blocker read therefore shares one snapshot and
 * one transaction with anonymisation: a committed create reservation refuses
 * deletion, while a deletion holding the row prevents a later KEY SHARE
 * reservation from passing its authoritative member re-read.
 */
export async function assertNoMemberContactCreateBlockerForDeletion(
  memberId: string,
  db: ContactCreateRecoveryDb,
): Promise<void> {
  if (await hasMemberContactCreateMergeBlocker(memberId, db)) {
    throw new XeroContactCreateBlocksDeletionError();
  }
}

export async function assertNoMemberContactChangeBlockerForDeletion(
  memberId: string,
  db: ContactCreateRecoveryDb,
): Promise<void> {
  if (await hasMemberContactChangeMergeBlocker(memberId, db)) {
    throw new XeroContactCreateBlocksDeletionError();
  }
}

/**
 * Standalone account-deletion side of the contact-create row protocol. The
 * live route already owns this Member row through its standing fan-out; taking
 * the same lock again is re-entrant and makes the production boundary directly
 * executable by the PostgreSQL race suite.
 */
export async function lockMemberForAccountDeletionXeroFence(
  db: ManualContactLinkFenceDb,
  memberId: string,
) {
  const member = await lockMemberForXeroContactLink(db, memberId);
  await assertNoMemberContactChangeBlockerForDeletion(memberId, db);
  return member;
}

export async function getMemberContactCreateRecoveryPending(params: {
  memberId: string;
  xeroContactId: string | null;
}): Promise<boolean> {
  if (params.xeroContactId) return false;
  return hasUnresolvedMemberContactCreateRecovery(params.memberId);
}

export async function getMemberContactCreateRecoveryState(params: {
  memberId: string;
  xeroContactId: string | null;
}): Promise<MemberContactCreateRecoveryState | null> {
  if (params.xeroContactId) return null;
  if (await hasUnresolvedMemberContactCreateRecovery(params.memberId)) {
    return "PROVIDER_CREATED_LINK_PENDING";
  }
  const reservation = await prisma.xeroSyncOperation.findFirst({
    where: ambiguousMemberContactCreateReservationWhere(params.memberId),
    select: { id: true },
  });
  return reservation ? "CREATE_IN_PROGRESS" : null;
}
