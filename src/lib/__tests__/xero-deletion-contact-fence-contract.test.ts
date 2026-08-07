import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

function between(
  input: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = input.indexOf(startMarker);
  expect(start, `missing start marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = input.indexOf(endMarker, start + startMarker.length);
  expect(end, `missing end marker: ${endMarker}`).toBeGreaterThan(start);
  return input.slice(start, end);
}

function expectOrdered(input: string, markers: string[]): void {
  let previous = -1;
  for (const marker of markers) {
    const at = input.indexOf(marker, previous + 1);
    expect(at, `missing or out-of-order marker: ${marker}`).toBeGreaterThan(
      previous,
    );
    previous = at;
  }
}

describe("Xero contact/account-deletion lock topology mutation pins (#2597)", () => {
  it("reserves only after the Member KEY SHARE re-read and ambiguous-create proof", () => {
    const block = between(
      source("src/lib/xero-contacts.ts"),
      "export async function reserveMemberContactCreateOperation(",
      "export interface XeroContactUpdateData",
    );

    expectOrdered(block, [
      "FOR KEY SHARE",
      "tx.member.findUnique",
      "assertMemberAvailableForXeroContactChange(locked)",
      "ambiguousMemberContactCreateReservationWhere(memberId)",
      "startXeroSyncOperation({ ...input, store: tx })",
    ]);
  });

  it("commits the reservation before authentication/provider work and re-locks before local attribution", () => {
    const block = between(
      source("src/lib/xero-contacts.ts"),
      "export async function createXeroContactForMember(",
      "export async function getContactFirstInvoiceDate(",
    );

    expectOrdered(block, [
      "reserveMemberContactCreateOperation(memberId",
      "getAuthenticatedXeroClient()",
      "persistProviderCreatedContactProofOrThrow(",
      "lockMemberForXeroContactLink(tx, memberId)",
      "tx.member.update",
    ]);
  });

  it("keeps the manual Member pointer and canonical CONTACT ledger in one transaction", () => {
    const block = between(
      source("src/lib/xero-manual-contact-link.ts"),
      "export async function commitManualXeroContactLink(",
      "  });\n}",
    );

    expectOrdered(block, [
      "db.$transaction",
      "lockMemberForManualXeroContactLink(tx, input.memberId)",
      "tx.member.update",
      "upsertXeroObjectLink(",
      "{ store: tx }",
    ]);
  });

  it("re-checks the complete Xero blocker under the deletion Member lock before anonymising", () => {
    const recovery = between(
      source("src/lib/xero-contact-create-recovery.ts"),
      "export async function lockMemberForAccountDeletionXeroFence(",
      "export async function getMemberContactCreateRecoveryPending(",
    );
    expectOrdered(recovery, [
      "lockMemberForXeroContactLink(db, memberId)",
      "assertNoMemberContactChangeBlockerForDeletion(memberId, db)",
    ]);

    const route = source("src/app/api/admin/deletion-requests/[id]/route.ts");
    expectOrdered(route, [
      "lockMemberForAccountDeletionXeroFence(tx, member.id)",
      "await tx.member.update",
      "passwordHash: DELETED_ACCOUNT_PASSWORD_HASH",
      "await tx.xeroObjectLink.updateMany",
    ]);
  });

  it("reserves member updates before provider work and completes the link under the same Member fence", () => {
    const contactSource = source("src/lib/xero-contacts.ts");
    const update = contactSource.slice(
      contactSource.indexOf("export async function updateXeroContact("),
    );
    expectOrdered(update, [
      "reserveMemberContactUpdateOperation(",
      "getAuthenticatedXeroClient()",
      "accountingApi.updateContact(",
      "completeMemberContactUpdateOperation(",
    ]);
    const completion = between(
      contactSource,
      "export async function completeMemberContactUpdateOperation(",
      "export interface XeroContactUpdateData",
    );
    expectOrdered(completion, [
      "lockMemberForXeroContactLink(tx, memberId)",
      "completeXeroSyncOperation(operationId, completion, { store: tx })",
    ]);
  });

  it("never falls back to stored PII for a Member contact-update retry", () => {
    const retry = between(
      source("src/lib/xero-operation-retry.ts"),
      "const retryInput =\n      operation.localModel",
      'if (operation.entityType === "INVOICE" && operation.operationType === "CREATE") {',
    );
    expect(retry).toContain('operation.localModel === "Member"');
    expect(retry).toContain("buildCurrentMemberContactUpdateRetryInput(operation)");
    expect(retry).not.toContain(
      "buildCurrentMemberContactUpdateRetryInput(operation)) ??",
    );
  });

  it("maps contention to privacy-safe route errors instead of provider detail", () => {
    const push = source("src/app/api/admin/members/[id]/xero-push/route.ts");
    const link = source("src/app/api/admin/members/[id]/xero-link/route.ts");
    const deletion = source("src/app/api/admin/deletion-requests/[id]/route.ts");

    expect(push).toContain("XeroContactCreateInProgressError");
    expect(push).toContain("XeroMemberUnavailableError");
    expect(link).toContain("XeroContactCreateInProgressError");
    expect(link).toContain("XeroMemberUnavailableError");
    expect(deletion).toContain("XeroContactCreateBlocksDeletionError");
    expect(deletion).toContain("deletionCleanupRecovery");
  });
});
