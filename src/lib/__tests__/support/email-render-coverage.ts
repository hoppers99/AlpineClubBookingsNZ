/**
 * What the rendered-email gate must cover, and the taxonomy it covers it by
 * (#2689).
 *
 * TAXONOMY. `REGISTRY_KEY_RENDERERS` maps every registry template key to the
 * function that renders it. It is NOT a new grouping scheme: each key/function
 * pair was read off the `sendEmail({ html: <fn>(...), templateName: "<key>" })`
 * call in the sender module that owns it, and the comment headings below name
 * that sender module. `src/lib/email/<family>.ts` is the repository's own
 * message-family boundary, and the #2689 split of the template monolith mirrors
 * it exactly — one `src/lib/email-templates/<family>.ts` per sender family.
 *
 * COVERAGE. `EMAIL_TEMPLATE_MODULE_EXPORTS` is read from the module namespaces
 * at runtime rather than listed by hand, so a newly exported render function
 * cannot be added without the gate noticing it has no render case.
 */
import * as account from "@/lib/email-templates/account";
import * as adminBooking from "@/lib/email-templates/admin-booking";
import * as adminFinance from "@/lib/email-templates/admin-finance";
import * as adminMembership from "@/lib/email-templates/admin-membership";
import * as adminOps from "@/lib/email-templates/admin-ops";
import * as adminXeroReports from "@/lib/email-templates/admin-xero-reports";
import * as booking from "@/lib/email-templates/booking";
import * as bookingExceptions from "@/lib/email-templates/booking-exceptions";
import * as bookingMoney from "@/lib/email-templates/booking-money";
import * as bookingReminders from "@/lib/email-templates/booking-reminders";
import * as bookingRequests from "@/lib/email-templates/booking-requests";
import * as chores from "@/lib/email-templates/chores";
import * as communications from "@/lib/email-templates/communications";
import * as escape from "@/lib/email-templates/escape";
import * as family from "@/lib/email-templates/family";
import * as familyBooking from "@/lib/email-templates/family-booking";
import * as groups from "@/lib/email-templates/groups";
import * as layout from "@/lib/email-templates/layout";
import * as memberGuest from "@/lib/email-templates/member-guest";
import * as membership from "@/lib/email-templates/membership";
import * as refunds from "@/lib/email-templates/refunds";
import * as waitlist from "@/lib/email-templates/waitlist";

function exportedFunctionNames(moduleNamespace: object): string[] {
  return Object.entries(moduleNamespace)
    .filter(([, value]) => typeof value === "function")
    .map(([name]) => name)
    .sort();
}

/** Every template module, and the render functions it exports. */
export const EMAIL_TEMPLATE_MODULE_EXPORTS: Record<string, string[]> = {
  "account": exportedFunctionNames(account),
  "admin-booking": exportedFunctionNames(adminBooking),
  "admin-finance": exportedFunctionNames(adminFinance),
  "admin-membership": exportedFunctionNames(adminMembership),
  "admin-ops": exportedFunctionNames(adminOps),
  "admin-xero-reports": exportedFunctionNames(adminXeroReports),
  "booking": exportedFunctionNames(booking),
  "booking-exceptions": exportedFunctionNames(bookingExceptions),
  "booking-money": exportedFunctionNames(bookingMoney),
  "booking-reminders": exportedFunctionNames(bookingReminders),
  "booking-requests": exportedFunctionNames(bookingRequests),
  "chores": exportedFunctionNames(chores),
  "communications": exportedFunctionNames(communications),
  "escape": exportedFunctionNames(escape),
  "family": exportedFunctionNames(family),
  "family-booking": exportedFunctionNames(familyBooking),
  "groups": exportedFunctionNames(groups),
  "layout": exportedFunctionNames(layout),
  "member-guest": exportedFunctionNames(memberGuest),
  "membership": exportedFunctionNames(membership),
  "refunds": exportedFunctionNames(refunds),
  "waitlist": exportedFunctionNames(waitlist),
};

/**
 * Registry template keys that deliberately have no template function: their
 * HTML is composed at the send site rather than in a template module.
 *
 * Both are noted rather than fixed here — #2689 is a structural split and
 * changing where these two compose their bodies would change output.
 */
export const REGISTRY_KEYS_WITHOUT_A_TEMPLATE_FUNCTION = new Set<string>([
  // Built inline in src/app/api/contact/route.ts.
  "website-contact",
  // Built inline in src/lib/email/core.ts and src/lib/cron-email-retry.ts.
  "admin-email-failure",
]);

/**
 * Registry template key -> the exported function that renders it, grouped by
 * the sender module (`src/lib/email/<family>.ts`) the pair was read from.
 *
 * `two-factor-code` is listed because a sender uses it as a `templateName`,
 * even though `email-message-audit-defaults.ts` carries no entry for it; the
 * gate iterates registry definitions, so the extra row is inert here.
 */
export const REGISTRY_KEY_RENDERERS: Record<string, string> = {
  // (admin API routes and notices)
  "bulk-communication": "bulkCommunicationTemplate",
  "notice-published": "noticePublishedTemplate",
  "refund-request-approved": "refundRequestApprovedTemplate",
  "refund-request-declined": "refundRequestDeclinedTemplate",
  // account
  "account-deletion-approved": "accountDeletionApprovedTemplate",
  "account-deletion-rejected": "accountDeletionRejectedTemplate",
  "admin-password-reset": "adminPasswordResetTemplate",
  "email-change-notification": "emailChangeNotificationTemplate",
  "email-change-verification": "emailChangeVerificationTemplate",
  "email-verification": "emailVerificationTemplate",
  "magic-link-login": "magicLinkLoginTemplate",
  "member-setup-invite": "memberSetupInviteTemplate",
  "password-reset": "passwordResetTemplate",
  "two-factor-code": "twoFactorCodeTemplate",
  // admin-alerts-booking
  "admin-booking-bumped": "adminBookingBumpedTemplate",
  "admin-booking-change-request": "adminBookingChangeRequestTemplate",
  "admin-booking-request-hold-cancelled": "adminBookingRequestHoldCancelledTemplate",
  "admin-booking-request-hold-expired": "adminBookingRequestHoldExpiredTemplate",
  "admin-booking-request-pending": "adminBookingRequestPendingTemplate",
  "admin-capacity-warning": "adminCapacityWarningTemplate",
  "admin-minors-review": "adminMinorsReviewRequiredTemplate",
  "admin-new-booking": "adminNewBookingTemplate",
  "admin-owner-substitution": "adminOwnerSubstitutionTemplate",
  "admin-partner-share-swept": "adminPartnerShareSweptTemplate",
  "admin-pending-deadline": "adminPendingDeadlineTemplate",
  "admin-school-manual-invoice": "adminSchoolManualInvoiceTemplate",
  "admin-split-settlement-cancelled": "adminSplitSettlementCancelledTemplate",
  "admin-split-settlement-unpaid": "adminSplitSettlementUnpaidTemplate",
  "admin-waitlist-offer": "adminWaitlistOfferTemplate",
  "admin-whole-lodge-manual-invoice": "adminWholeLodgeManualInvoiceTemplate",
  // admin-alerts-finance
  "admin-credit-sync-drift": "adminCreditSyncDriftTemplate",
  "admin-duplicate-capture-refund": "adminDuplicateCaptureRefundTemplate",
  "admin-late-capture-auto-refund": "adminLateCaptureAutoRefundTemplate",
  "admin-late-capture-hand-back-conflict": "adminLateCaptureHandBackConflictTemplate",
  "admin-manual-refund-task": "adminManualRefundTaskTemplate",
  "admin-manual-settlement-conflict": "adminManualSettlementConflictTemplate",
  "admin-payment-failure": "adminPaymentFailureTemplate",
  "admin-refund-request": "adminRefundRequestTemplate",
  "admin-xero-reconciliation-report": "adminXeroReconciliationReportTemplate",
  "admin-xero-repeated-failure": "adminXeroRepeatedFailureTemplate",
  "admin-xero-sync-error": "adminXeroSyncErrorTemplate",
  // admin-alerts-membership
  "admin-account-deletion-requested": "adminAccountDeletionRequestedTemplate",
  "admin-family-group-request": "adminFamilyGroupRequestTemplate",
  "admin-member-archive-requested": "adminMemberArchiveRequestedTemplate",
  "admin-member-delete-approved": "adminMemberDeleteApprovedTemplate",
  "admin-member-delete-rejected": "adminMemberDeleteRejectedTemplate",
  "admin-member-delete-requested": "adminMemberDeleteRequestedTemplate",
  "admin-membership-application-pending": "adminMembershipApplicationPendingTemplate",
  "admin-membership-cancellation-request": "adminMembershipCancellationRequestTemplate",
  // admin-alerts-ops
  "admin-daily-digest": "adminDailyDigestTemplate",
  "admin-issue-report": "adminIssueReportTemplate",
  // booking
  "additional-payment-reminder": "additionalPaymentReminderTemplate",
  "booking-bumped": "bookingBumpedTemplate",
  "booking-cancelled": "bookingCancelledTemplate",
  "booking-confirmed": "bookingConfirmedTemplate",
  "booking-guests-cancelled": "bookingGuestsCancelledTemplate",
  "booking-modified": "bookingModifiedTemplate",
  "booking-pending": "bookingPendingTemplate",
  "booking-policy-exception-approved": "bookingPolicyExceptionApprovedTemplate",
  "booking-policy-exception-refused": "bookingPolicyExceptionRefusedTemplate",
  "booking-review-approved": "bookingReviewApprovedTemplate",
  "booking-review-rejected": "bookingReviewRejectedTemplate",
  "checkin-reminder": "checkinReminderTemplate",
  "hosting-coverage-lost": "hostingCoverageLostTemplate",
  "policy-exception-request-expired": "policyExceptionRequestExpiredTemplate",
  "pre-arrival-reminder": "preArrivalReminderTemplate",
  "setup-intent-failed": "setupIntentFailedTemplate",
  "split-guest-portion-cancelled": "splitGuestPortionCancelledTemplate",
  "whole-lodge-guest-names-reminder": "wholeLodgeGuestNamesReminderTemplate",
  // booking-requests
  "booking-request-approved": "bookingRequestApprovedTemplate",
  "booking-request-declined": "bookingRequestDeclinedTemplate",
  "booking-request-payment-expired": "bookingRequestPaymentExpiredTemplate",
  "booking-request-quote": "bookingRequestQuoteTemplate",
  "booking-request-verification": "bookingRequestVerificationTemplate",
  "school-attendee-confirmation": "schoolAttendeeConfirmationTemplate",
  "split-guest-payment-link": "splitGuestPaymentLinkTemplate",
  // chores
  "chore-roster": "choreRosterTemplate",
  "hut-leader-assignment": "hutLeaderAssignmentTemplate",
  // family
  "child-request-approved": "childRequestApprovedTemplate",
  "child-request-rejected": "childRequestRejectedTemplate",
  "child-request-submitted": "childRequestSubmittedTemplate",
  "family-group-create-approved": "groupCreateApprovedTemplate",
  "family-group-create-rejected": "groupCreateRejectedTemplate",
  "family-group-create-request-confirmation": "groupCreateRequestConfirmationTemplate",
  "family-group-invitation": "familyGroupInvitationTemplate",
  "family-group-invite-accepted": "familyGroupInviteAcceptedTemplate",
  "join-request-confirmation": "joinRequestConfirmationTemplate",
  "partner-invite": "partnerInviteTemplate",
  "partner-invite-claimed": "partnerInviteClaimedTemplate",
  "partner-link-confirmed": "partnerLinkConfirmedTemplate",
  "partner-link-removed": "partnerLinkRemovedTemplate",
  "partner-link-request": "partnerLinkRequestTemplate",
  // family-booking
  "family-member-added": "familyMemberBookingAddedTemplate",
  // groups
  "group-booking-join-verification": "bookingRequestVerificationTemplate",
  "group-join-cancelled": "groupJoinCancelledTemplate",
  "group-join-released": "groupJoinReleasedTemplate",
  "group-join-settled": "groupJoinSettledTemplate",
  "group-settlement-expired": "groupSettlementExpiredTemplate",
  "group-settlement-receipt": "groupSettlementReceiptTemplate",
  // member-guest
  "member-guest-added": "memberGuestAddedTemplate",
  "member-guest-consent-answered": "memberGuestConsentAnsweredTemplate",
  "member-guest-consent-expired": "memberGuestConsentExpiredTemplate",
  "member-guest-consent-outcome": "memberGuestConsentOutcomeTemplate",
  "member-guest-consent-request": "memberGuestConsentRequestTemplate",
  "member-guest-request-withdrawn": "memberGuestRequestWithdrawnTemplate",
  // membership
  "age-up-invitation": "ageUpInvitationTemplate",
  "age-up-parent-email-handoff": "ageUpParentEmailHandoffTemplate",
  "induction-sign-off-request": "inductionSignOffRequestTemplate",
  "member-archive-approved": "memberArchiveApprovedTemplate",
  "member-archive-rejected": "memberArchiveRejectedTemplate",
  "membership-application-approved": "membershipApplicationApprovedTemplate",
  "membership-application-rejected": "membershipApplicationRejectedTemplate",
  "membership-cancellation-approved": "membershipCancellationApprovedTemplate",
  "membership-cancellation-confirmation": "membershipCancellationConfirmationTemplate",
  "membership-cancellation-rejected": "membershipCancellationRejectedTemplate",
  "membership-cancellation-submitted": "membershipCancellationSubmittedTemplate",
  "membership-payment-recorded": "membershipPaymentRecordedTemplate",
  "nomination-request": "nominationRequestTemplate",
  // waitlist
  "waitlist-confirmation": "waitlistConfirmationTemplate",
  "waitlist-offer": "waitlistOfferTemplate",
  "waitlist-offer-expired": "waitlistOfferExpiredTemplate",
  "waitlist-place-restored": "waitlistPlaceRestoredTemplate",
};
