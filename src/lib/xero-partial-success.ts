export type XeroPartialSuccessKind =
  | "CONTACT_CREATED_LINK_UNCONFIRMED"
  | "CONTACT_CREATED_AND_LINKED"
  | "CONTACT_LINKED"
  | "CONTACT_UNLINKED"
  | "MEMBER_IMPORTED_AND_LINKED";

export interface XeroPartialSuccessRecovery {
  recoveryKind: XeroPartialSuccessKind;
  xeroContactCreated?: true;
  xeroContactLinked?: boolean;
  xeroContactUnlinked?: true;
  xeroContactId?: string;
  xeroLinkMayHaveChanged?: true;
  memberImported?: true;
  memberId?: string;
  subscriptionRefreshPending?: true;
  subscriptionCleanupPending?: true;
  xeroPostProcessingPending: true;
}

export const XERO_PARTIAL_SUCCESS_MESSAGES: Record<
  XeroPartialSuccessKind,
  string
> = {
  CONTACT_CREATED_LINK_UNCONFIRMED:
    "A Xero contact was created, but its local member link could not be confirmed. Do not create another contact. Reload the member, search Xero for the contact, and link it if needed.",
  CONTACT_CREATED_AND_LINKED:
    "The Xero contact was created and linked, but later local processing did not finish. Do not create another contact. Reload the member and run the Member Status Repair Backfill if subscription history is incomplete.",
  CONTACT_LINKED:
    "The member was linked to the Xero contact, but later local processing did not finish. Do not link it again. Reload the member and run the Member Status Repair Backfill if subscription history is incomplete.",
  CONTACT_UNLINKED:
    "The member's Xero link was removed, but later local processing did not finish. Do not unlink it again. Reload the member and run the Member Status Repair Backfill if subscription history is incomplete.",
  MEMBER_IMPORTED_AND_LINKED:
    "The member was imported and linked to Xero, but later local setup did not finish. Do not import this contact again. Reload the member and run the Member Status Repair Backfill if subscription history is incomplete.",
};

export function xeroPartialSuccessBody(
  recovery: XeroPartialSuccessRecovery,
) {
  return {
    code: "XERO_PARTIAL_SUCCESS" as const,
    error: XERO_PARTIAL_SUCCESS_MESSAGES[recovery.recoveryKind],
    ...recovery,
  };
}

export function isXeroPartialSuccessRecovery(
  value: unknown,
): value is XeroPartialSuccessRecovery {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.recoveryKind === "string" &&
    candidate.recoveryKind in XERO_PARTIAL_SUCCESS_MESSAGES &&
    candidate.xeroPostProcessingPending === true
  );
}

export function getXeroPartialSuccessGuidance(
  recovery: XeroPartialSuccessRecovery,
): string {
  return XERO_PARTIAL_SUCCESS_MESSAGES[recovery.recoveryKind];
}

export function createdContactRecovery(
  xeroContactId: string,
  linked: boolean,
  subscriptionRefreshPending = linked,
): XeroPartialSuccessRecovery {
  return linked
    ? {
        recoveryKind: "CONTACT_CREATED_AND_LINKED",
        xeroContactCreated: true,
        xeroContactLinked: true,
        xeroContactId,
        ...(subscriptionRefreshPending
          ? { subscriptionRefreshPending: true as const }
          : {}),
        xeroPostProcessingPending: true,
      }
    : {
        recoveryKind: "CONTACT_CREATED_LINK_UNCONFIRMED",
        xeroContactCreated: true,
        xeroContactId,
        xeroPostProcessingPending: true,
      };
}

export function linkedContactRecovery(
  xeroContactId: string,
  subscriptionRefreshPending: boolean,
): XeroPartialSuccessRecovery {
  return {
    recoveryKind: "CONTACT_LINKED",
    xeroContactLinked: true,
    xeroContactId,
    xeroLinkMayHaveChanged: true,
    ...(subscriptionRefreshPending
      ? { subscriptionRefreshPending: true as const }
      : {}),
    xeroPostProcessingPending: true,
  };
}

export function unlinkedContactRecovery(
  subscriptionCleanupPending: boolean,
): XeroPartialSuccessRecovery {
  return {
    recoveryKind: "CONTACT_UNLINKED",
    xeroContactUnlinked: true,
    xeroLinkMayHaveChanged: true,
    ...(subscriptionCleanupPending
      ? { subscriptionCleanupPending: true as const }
      : {}),
    xeroPostProcessingPending: true,
  };
}

export function importedMemberRecovery(
  memberId: string,
  xeroContactId: string,
  subscriptionRefreshPending: boolean,
): XeroPartialSuccessRecovery {
  return {
    recoveryKind: "MEMBER_IMPORTED_AND_LINKED",
    memberImported: true,
    memberId,
    xeroContactLinked: true,
    xeroContactId,
    ...(subscriptionRefreshPending
      ? { subscriptionRefreshPending: true as const }
      : {}),
    xeroPostProcessingPending: true,
  };
}
