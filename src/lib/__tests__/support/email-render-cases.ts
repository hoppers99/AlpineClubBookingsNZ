/**
 * The rendered-output corpus for every email template function (#2689).
 *
 * WHY THIS EXISTS. `src/lib/email-templates.ts` was a 5,000-line monolith that
 * #2689 split into one module per message family. Email HTML is inline-CSS and
 * order-dependent, so moving a style block between modules can change the
 * cascade a mail client applies: a structural move that reads as mechanical in
 * the diff can still change what a member sees. The owner's rule for that split
 * is that rendered output stays byte-for-byte invariant, and that ANY diff is a
 * blocking finding rather than an acceptable side effect.
 *
 * WHAT IT IS. One entry per template function per argument shape, each one
 * rendering a COMPLETE body — never a fragment, never just a function name.
 * Two shapes are generated for every function that has optional parameters:
 *   `:minimal` — required parameters only, pinning the no-optional-branch body;
 *   `:full`    — every optional parameter supplied, pinning the optional blocks
 *                and their inline styles as well.
 * A function with no optional parameters carries only `:minimal`. Helpers that
 * return data rather than HTML (money rows, credit-netting outcomes) are pinned
 * through `JSON.stringify`, so the corpus covers the exported surface uniformly.
 *
 * Values are deterministic literals — never `new Date()`, `Math.random()` or an
 * environment read — so the same case always renders the same bytes.
 * `email-render-equivalence.test.ts` hashes each body and compares it with the
 * committed pins in `email-render-pins.txt`.
 *
 * ADDING A TEMPLATE. Add its case here; the test fails if any exported render
 * function, or any registry template key, has no case.
 */
import type {
  CreditSyncDriftReportEmail,
  XeroReconciliationReportEmail,
} from "@/lib/email-templates";
import * as T from "@/lib/email-templates";

export interface EmailRenderCase {
  /** Stable identity: `<functionName>:<argument shape>`. */
  id: string;
  /** The exported function this case renders, for the coverage assertions. */
  fn: string;
  /** Renders the complete body. Must be pure and deterministic. */
  render: () => string;
}

const FIXED_DATE = (iso: string) => new Date(iso);

/**
 * Data helpers return values, not HTML. `JSON.stringify` yields `undefined`
 * (the value) for an undefined result, which is not a body to pin — spell that
 * outcome as text so it is pinned like any other.
 */
const json = (value: unknown) => JSON.stringify(value) ?? "undefined";

/**
 * The Xero reconciliation report with only the fields the template always
 * reads: no issue sections, no repeated failures, no unsupported partials.
 */
const XERO_REPORT_MINIMAL: XeroReconciliationReportEmail = {
  generatedAt: FIXED_DATE("2026-03-02T21:30:00.000Z"),
  lookbackHours: 24,
  stalePendingMinutes: 45,
  summary: {
    missingMemberContactLinks: 1,
    missingPaymentInvoiceLinks: 2,
    missingPaymentRefundCreditNoteLinks: 3,
    missingSubscriptionInvoiceLinks: 4,
    mismatchedCanonicalLinks: 5,
    staleCanonicalLinks: 6,
    duplicateActiveCanonicalLinks: 7,
    stalePendingOperations: 8,
    recentFailedOperations: 9,
    recentPartialOperations: 10,
    unsupportedPartialOperations: 11,
    repeatedFailureCorrelations: 12,
    failedInboundEvents: 13,
    issueCategoryCount: 0,
    issueTotalCount: 0,
  },
  repeatedFailures: [],
  unsupportedPartials: [],
};

/**
 * The same report with every optional block populated, including one issue item
 * per severity so the severity styling is pinned as well.
 */
const XERO_REPORT_FULL: XeroReconciliationReportEmail = {
  ...XERO_REPORT_MINIMAL,
  summary: { ...XERO_REPORT_MINIMAL.summary, issueCategoryCount: 3, issueTotalCount: 3 },
  issueSections: (["critical", "warning", "info"] as const).map((severity, index) => ({
    id: `section-${severity}`,
    title: `Section ${severity}`,
    severity,
    count: index + 1,
    whatWentWrong: `What went wrong (${severity})`,
    howToFix: `How to fix (${severity})`,
    items: [
      {
        label: `Item ${severity}`,
        localModel: "Booking",
        localId: `booking-${index}`,
        localUrl: "/admin/bookings/booking-0",
        xeroObjectType: "Invoice",
        xeroObjectId: `xero-${index}`,
        xeroObjectNumber: `INV-000${index}`,
        xeroObjectUrl: "https://go.xero.example/invoice",
        operationId: `op-${index}`,
        operationStatus: "FAILED",
        operationType: "CREATE_INVOICE",
        correlationKey: `corr-${index}`,
        detail: `Detail line ${index}`,
        latestErrorMessage: `Latest error ${index}`,
        createdAt: FIXED_DATE("2026-03-01T02:15:00.000Z"),
      },
    ],
  })),
  repeatedFailures: [
    {
      correlationKey: "corr-repeat",
      failureCount: 4,
      entityType: "Payment",
      operationType: "CREATE_PAYMENT",
      localModel: "Payment",
      localId: "payment-1",
      localUrl: "/admin/payments/payment-1",
      latestErrorMessage: "Repeated failure message",
      latestOperationId: "op-repeat",
      latestOperationStatus: "FAILED",
      latestOperationCreatedAt: FIXED_DATE("2026-03-01T03:00:00.000Z"),
      xeroObjectType: "Invoice",
      xeroObjectId: "xero-repeat",
      xeroObjectNumber: "INV-9999",
      xeroObjectUrl: "https://go.xero.example/invoice-repeat",
    },
  ],
  unsupportedPartials: [
    {
      operationId: "op-partial",
      entityType: "CreditNote",
      operationType: "APPLY_CREDIT_NOTE",
      localModel: "Payment",
      localId: "payment-2",
      localUrl: "/admin/payments/payment-2",
      xeroObjectType: "CreditNote",
      xeroObjectId: "xero-partial",
      xeroObjectNumber: "CN-0001",
      xeroObjectUrl: "https://go.xero.example/credit-note",
      reason: "Partial application is not supported",
      createdAt: FIXED_DATE("2026-03-01T04:00:00.000Z"),
    },
  ],
};

/** A drift report with nothing to list — the clean-run body. */
const CREDIT_DRIFT_MINIMAL: CreditSyncDriftReportEmail = {
  generatedAt: FIXED_DATE("2026-03-02T21:30:00.000Z"),
  scannedBookings: 120,
  checkedBookings: 118,
  deferredBookings: 2,
  totalDriftCents: 0,
  drifts: [],
};

/** One drift of each kind, so every direction label is pinned. */
const CREDIT_DRIFT_FULL: CreditSyncDriftReportEmail = {
  ...CREDIT_DRIFT_MINIMAL,
  totalDriftCents: 4500,
  drifts: (["missing_in_xero", "excess_in_xero", "no_invoice"] as const).map(
    (kind, index) => ({
      kind,
      bookingId: `booking-${index}`,
      memberName: `Member ${index}`,
      invoiceId: kind === "no_invoice" ? null : `inv-${index}`,
      invoiceNumber: kind === "no_invoice" ? null : `INV-100${index}`,
      invoiceUrl: kind === "no_invoice" ? null : "https://go.xero.example/invoice",
      localCents: 5000 + index,
      xeroCents: 3000 + index,
      deltaCents: 2000,
      notes: [
        {
          creditNoteId: `cn-${index}`,
          creditNoteNumber: `CN-200${index}`,
          appliedCents: 1000 + index,
        },
      ],
    }),
  ),
};

/**
 * The four credit-netting outcomes, spelled out rather than generated: they are
 * the money shapes an unpaid confirmation can take, and each one renders
 * different rows (see `resolveUnpaidCreditNetting`).
 */
const NETTING_OUTCOMES = [
  { outcome: "none", creditCents: 0, toTransferCents: 30000 },
  { outcome: "netted", creditCents: 12000, toTransferCents: 18000 },
  { outcome: "covered", creditCents: 30000, toTransferCents: 0 },
  { outcome: "unreconciled", creditCents: 0, toTransferCents: 0 },
] as const;

const formatTestCents = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/**
 * Money-branch cases the generated corpus cannot reach: every netting outcome
 * through both renderers, and the settlement methods that label the credit
 * lines on a paid confirmation.
 */
const MONEY_BRANCH_CASES: EmailRenderCase[] = [
  ...NETTING_OUTCOMES.flatMap((netting): EmailRenderCase[] => [
    {
      id: `unpaidMoneySummaryRows:outcome-${netting.outcome}`,
      fn: "unpaidMoneySummaryRows",
      render: () => json(T.unpaidMoneySummaryRows(30000, netting)),
    },
    {
      id: `unpaidCreditNoteInput:outcome-${netting.outcome}`,
      fn: "unpaidCreditNoteInput",
      render: () =>
        json(T.unpaidCreditNoteInput(30000, netting, formatTestCents)),
    },
  ]),
  ...(["card", "bank_transfer", "manual"] as const).map(
    (settlementMethod): EmailRenderCase => ({
      id: `appliedCreditSummaryRows:settled-${settlementMethod}`,
      fn: "appliedCreditSummaryRows",
      render: () =>
        json(T.appliedCreditSummaryRows(12000, 18000, settlementMethod)),
    }),
  ),
  {
    id: "appliedCreditSummaryRows:settled-zero",
    fn: "appliedCreditSummaryRows",
    render: () => json(T.appliedCreditSummaryRows(30000, 0, "card")),
  },
  {
    id: "bookingConfirmedTemplate:payment-due",
    fn: "bookingConfirmedTemplate",
    render: () =>
      T.bookingConfirmedTemplate(
        "Ada",
        FIXED_DATE("2026-07-04T00:00:00.000Z"),
        FIXED_DATE("2026-07-06T00:00:00.000Z"),
        3,
        30000,
        { paymentDue: { reference: "TKC-0001", invoiceEmailed: false } },
      ),
  },
  {
    id: "bookingConfirmedTemplate:outstanding-balance",
    fn: "bookingConfirmedTemplate",
    render: () =>
      T.bookingConfirmedTemplate(
        "Ada",
        FIXED_DATE("2026-07-04T00:00:00.000Z"),
        FIXED_DATE("2026-07-06T00:00:00.000Z"),
        3,
        30000,
        { outstandingBalance: { amountCents: 4500, payableOnline: false } },
      ),
  },
  {
    id: "bookingConfirmedTemplate:applied-credit-only",
    fn: "bookingConfirmedTemplate",
    render: () =>
      T.bookingConfirmedTemplate(
        "Ada",
        FIXED_DATE("2026-07-04T00:00:00.000Z"),
        FIXED_DATE("2026-07-06T00:00:00.000Z"),
        3,
        30000,
        { appliedCredit: { amountCents: 12000, settlementMethod: "manual" } },
      ),
  },
  {
    id: "bookingCancelledTemplate:refund-manual",
    fn: "bookingCancelledTemplate",
    render: () =>
      T.bookingCancelledTemplate(
        "Ada",
        FIXED_DATE("2026-07-04T00:00:00.000Z"),
        FIXED_DATE("2026-07-06T00:00:00.000Z"),
        12000,
        "manual",
        3000,
      ),
  },
];

/** Generated from the exported signatures; see the module docblock. */
const GENERATED_CASES: EmailRenderCase[] = [
  { id: "escapeHtml:minimal", fn: "escapeHtml", render: () =>
    T.escapeHtml("str-1") },
  { id: "plainTextEmailTemplate:minimal", fn: "plainTextEmailTemplate", render: () =>
    T.plainTextEmailTemplate("bodyText-1") },
  { id: "passwordResetTemplate:minimal", fn: "passwordResetTemplate", render: () =>
    T.passwordResetTemplate("resetUrl-1") },
  { id: "magicLinkLoginTemplate:minimal", fn: "magicLinkLoginTemplate", render: () =>
    T.magicLinkLoginTemplate("loginUrl-1") },
  { id: "adminPasswordResetTemplate:minimal", fn: "adminPasswordResetTemplate", render: () =>
    T.adminPasswordResetTemplate("resetUrl-1") },
  { id: "adminPasswordResetTemplate:full", fn: "adminPasswordResetTemplate", render: () =>
    T.adminPasswordResetTemplate("resetUrl-1", "1 hour") },
  { id: "memberSetupInviteTemplate:minimal", fn: "memberSetupInviteTemplate", render: () =>
    T.memberSetupInviteTemplate("firstName-1", "resetUrl-2") },
  { id: "twoFactorCodeTemplate:minimal", fn: "twoFactorCodeTemplate", render: () =>
    T.twoFactorCodeTemplate({ firstName: "firstName-1", code: "code-2", expiresAt: new Date("2026-03-04T00:00:00.000Z") }) },
  { id: "resolvePromoAdjustmentCents:minimal", fn: "resolvePromoAdjustmentCents", render: () =>
    json(T.resolvePromoAdjustmentCents()) },
  { id: "resolvePromoAdjustmentCents:full", fn: "resolvePromoAdjustmentCents", render: () =>
    json(T.resolvePromoAdjustmentCents({ discountCents: 101, promoAdjustmentCents: 102 })) },
  { id: "promoAdjustmentSummaryRows:minimal", fn: "promoAdjustmentSummaryRows", render: () =>
    json(T.promoAdjustmentSummaryRows(101, 102)) },
  { id: "promoAdjustmentSummaryRows:full", fn: "promoAdjustmentSummaryRows", render: () =>
    json(T.promoAdjustmentSummaryRows(101, 102, "promoCode-3")) },
  { id: "appliedCreditSummaryRows:minimal", fn: "appliedCreditSummaryRows", render: () =>
    json(T.appliedCreditSummaryRows(101, 102)) },
  { id: "appliedCreditSummaryRows:full", fn: "appliedCreditSummaryRows", render: () =>
    json(T.appliedCreditSummaryRows(101, 102, "manual" as const)) },
  { id: "settledByPaymentCents:minimal", fn: "settledByPaymentCents", render: () =>
    json(T.settledByPaymentCents({ totalCents: 101, appliedCreditCents: 102, unpaid: true, outstandingCents: 103 })) },
  { id: "resolveUnpaidCreditNetting:minimal", fn: "resolveUnpaidCreditNetting", render: () =>
    json(T.resolveUnpaidCreditNetting({ totalCents: 101, appliedCreditCents: 102 })) },
  { id: "unpaidCreditNoteInput:minimal", fn: "unpaidCreditNoteInput", render: () =>
    json(T.unpaidCreditNoteInput(101, { outcome: "netted" as const, creditCents: 2500, toTransferCents: 7500 }, (cents: number) => `$${(cents / 100).toFixed(2)}`)) },
  { id: "unpaidCreditNoteInput:full", fn: "unpaidCreditNoteInput", render: () =>
    json(T.unpaidCreditNoteInput(101, { outcome: "covered" as const, creditCents: 10000, toTransferCents: 0 }, (cents: number) => `$${(cents / 100).toFixed(2)}`)) },
  { id: "wholeLodgeManualInvoiceAmountCents:minimal", fn: "wholeLodgeManualInvoiceAmountCents", render: () =>
    json(T.wholeLodgeManualInvoiceAmountCents(101, 102)) },
  { id: "unpaidMoneySummaryRows:minimal", fn: "unpaidMoneySummaryRows", render: () =>
    json(T.unpaidMoneySummaryRows(101, { outcome: "netted" as const, creditCents: 2500, toTransferCents: 7500 })) },
  { id: "unpaidMoneySummaryRows:full", fn: "unpaidMoneySummaryRows", render: () =>
    json(T.unpaidMoneySummaryRows(101, { outcome: "covered" as const, creditCents: 10000, toTransferCents: 0 })) },
  { id: "bookingConfirmedTemplate:minimal", fn: "bookingConfirmedTemplate", render: () =>
    T.bookingConfirmedTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, 105) },
  { id: "bookingConfirmedTemplate:full", fn: "bookingConfirmedTemplate", render: () =>
    T.bookingConfirmedTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, 105, { discountCents: 106, promoAdjustmentCents: 107, promoCode: "promoCode-8", appliedCredit: { amountCents: 12345, settlementMethod: "bank_transfer" as const }, lodgeTravelNote: "lodgeTravelNote-9", doorCode: "doorCode-10", provisionalGuests: { guestCount: 111, holdUntil: new Date("2026-03-13T00:00:00.000Z") }, paymentDue: { reference: "reference-13", invoiceEmailed: true }, outstandingBalance: { amountCents: 114, payableOnline: true } }) },
  { id: "bookingPendingTemplate:minimal", fn: "bookingPendingTemplate", render: () =>
    T.bookingPendingTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, new Date("2026-03-06T00:00:00.000Z")) },
  { id: "bookingPolicyExceptionApprovedTemplate:minimal", fn: "bookingPolicyExceptionApprovedTemplate", render: () =>
    T.bookingPolicyExceptionApprovedTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, paymentNote: "paymentNote-5", adminNotesLine: "adminNotesLine-6" }) },
  { id: "bookingPolicyExceptionRefusedTemplate:minimal", fn: "bookingPolicyExceptionRefusedTemplate", render: () =>
    T.bookingPolicyExceptionRefusedTemplate({ firstName: "firstName-1", lodgeName: "lodgeName-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), reasonLine: "reasonLine-5", askDescription: "askDescription-6" }) },
  { id: "bookingBumpedTemplate:minimal", fn: "bookingBumpedTemplate", render: () =>
    T.bookingBumpedTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, true) },
  { id: "bookingCancelledTemplate:minimal", fn: "bookingCancelledTemplate", render: () =>
    T.bookingCancelledTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104) },
  { id: "bookingCancelledTemplate:full", fn: "bookingCancelledTemplate", render: () =>
    T.bookingCancelledTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, "credit", 105) },
  { id: "bookingGuestsCancelledTemplate:minimal", fn: "bookingGuestsCancelledTemplate", render: () =>
    T.bookingGuestsCancelledTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z")) },
  { id: "bookingReviewApprovedTemplate:minimal", fn: "bookingReviewApprovedTemplate", render: () =>
    T.bookingReviewApprovedTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), "adminNotes-4", "bookingId-5") },
  { id: "bookingReviewRejectedTemplate:minimal", fn: "bookingReviewRejectedTemplate", render: () =>
    T.bookingReviewRejectedTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), "adminNotes-4") },
  { id: "emailVerificationTemplate:minimal", fn: "emailVerificationTemplate", render: () =>
    T.emailVerificationTemplate("firstName-1", "verifyUrl-2", new Date("2026-03-04T00:00:00.000Z")) },
  { id: "nominationRequestTemplate:minimal", fn: "nominationRequestTemplate", render: () =>
    T.nominationRequestTemplate({ nominatorName: "nominatorName-1", applicantName: "applicantName-2", reviewUrl: "reviewUrl-3", familyMemberCount: 104, expiresAt: new Date("2026-03-06T00:00:00.000Z") }) },
  { id: "inductionSignOffRequestTemplate:minimal", fn: "inductionSignOffRequestTemplate", render: () =>
    T.inductionSignOffRequestTemplate({ signerName: "signerName-1", inducteeName: "inducteeName-2", signerRoleLabel: "signerRoleLabel-3", inductionUrl: "inductionUrl-4" }) },
  { id: "emailChangeVerificationTemplate:minimal", fn: "emailChangeVerificationTemplate", render: () =>
    T.emailChangeVerificationTemplate("newEmail-1", "verifyUrl-2", new Date("2026-03-04T00:00:00.000Z")) },
  { id: "emailChangeNotificationTemplate:minimal", fn: "emailChangeNotificationTemplate", render: () =>
    T.emailChangeNotificationTemplate("newEmail-1") },
  { id: "formatChoreRosterDate:minimal", fn: "formatChoreRosterDate", render: () =>
    T.formatChoreRosterDate("date-1") },
  { id: "choreRosterTemplate:minimal", fn: "choreRosterTemplate", render: () =>
    T.choreRosterTemplate("guestName-1", "date-2", [{ name: "name-3", description: "description-4" }]) },
  { id: "choreRosterTemplate:full", fn: "choreRosterTemplate", render: () =>
    T.choreRosterTemplate("guestName-1", "date-2", [{ name: "name-3", description: "description-4" }], "choreLink-5") },
  { id: "hutLeaderAssignmentTemplate:minimal", fn: "hutLeaderAssignmentTemplate", render: () =>
    T.hutLeaderAssignmentTemplate({ firstName: "firstName-1", startDate: new Date("2026-03-03T00:00:00.000Z"), endDate: new Date("2026-03-04T00:00:00.000Z"), pin: "pin-4", assignmentId: "assignmentId-5" }) },
  { id: "checkinReminderTemplate:minimal", fn: "checkinReminderTemplate", render: () =>
    T.checkinReminderTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), [{ firstName: "firstName-4", lastName: "lastName-5" }], [{ name: "name-6", description: "description-7" }]) },
  { id: "preArrivalReminderTemplate:minimal", fn: "preArrivalReminderTemplate", render: () =>
    T.preArrivalReminderTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, lodgeTravelNote: "lodgeTravelNote-5" }) },
  { id: "preArrivalReminderTemplate:full", fn: "preArrivalReminderTemplate", render: () =>
    T.preArrivalReminderTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, expectedArrivalTime: "expectedArrivalTime-5", lodgeTravelNote: "lodgeTravelNote-6", doorCode: "doorCode-7", outstandingAdditionalAmountCents: 108, checkoutChoreNote: "checkoutChoreNote-9" }) },
  { id: "additionalPaymentReminderTemplate:minimal", fn: "additionalPaymentReminderTemplate", render: () =>
    T.additionalPaymentReminderTemplate({ firstName: "firstName-1", additionalAmountCents: 102, checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), requestedOn: new Date("2026-03-06T00:00:00.000Z") }) },
  { id: "adminNewBookingTemplate:minimal", fn: "adminNewBookingTemplate", render: () =>
    T.adminNewBookingTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, totalCents: 105, status: "status-6" }) },
  { id: "adminNewBookingTemplate:full", fn: "adminNewBookingTemplate", render: () =>
    T.adminNewBookingTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, totalCents: 105, status: "status-6", reviewReason: "reviewReason-7", memberJustification: "memberJustification-8" }) },
  { id: "adminMinorsReviewRequiredTemplate:minimal", fn: "adminMinorsReviewRequiredTemplate", render: () =>
    T.adminMinorsReviewRequiredTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, reviewReason: "reviewReason-5" }) },
  { id: "adminPartnerShareSweptTemplate:minimal", fn: "adminPartnerShareSweptTemplate", render: () =>
    T.adminPartnerShareSweptTemplate({ memberName: "memberName-1", partnerName: "partnerName-2", reason: "reason-3", nights: [new Date("2026-03-05T00:00:00.000Z")] }) },
  { id: "adminOwnerSubstitutionTemplate:minimal", fn: "adminOwnerSubstitutionTemplate", render: () =>
    T.adminOwnerSubstitutionTemplate({ requestId: "requestId-1", bookingId: "bookingId-2", intendedMemberId: "intendedMemberId-3", substituteMemberId: "substituteMemberId-4", reason: "reason-5", requesterName: "requesterName-6", requesterEmail: "requesterEmail-7", checkIn: new Date("2026-03-09T00:00:00.000Z"), checkOut: new Date("2026-03-10T00:00:00.000Z") }) },
  { id: "adminOwnerSubstitutionTemplate:full", fn: "adminOwnerSubstitutionTemplate", render: () =>
    T.adminOwnerSubstitutionTemplate({ requestId: "requestId-1", bookingId: "bookingId-2", intendedMemberId: "intendedMemberId-3", intendedMemberName: "intendedMemberName-4", substituteMemberId: "substituteMemberId-5", substituteMemberName: "substituteMemberName-6", reason: "reason-7", requesterName: "requesterName-8", requesterEmail: "requesterEmail-9", checkIn: new Date("2026-03-11T00:00:00.000Z"), checkOut: new Date("2026-03-12T00:00:00.000Z") }) },
  { id: "adminPaymentFailureTemplate:minimal", fn: "adminPaymentFailureTemplate", render: () =>
    T.adminPaymentFailureTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, errorMessage: "errorMessage-5", paymentIntentId: "paymentIntentId-6" }) },
  { id: "adminDuplicateCaptureRefundTemplate:minimal", fn: "adminDuplicateCaptureRefundTemplate", render: () =>
    T.adminDuplicateCaptureRefundTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, paymentIntentId: "paymentIntentId-5", settledPaymentIntentId: "settledPaymentIntentId-6", operationReference: "operationReference-7", reviewUrl: "reviewUrl-8", refundFailed: true }) },
  { id: "adminDuplicateCaptureRefundTemplate:full", fn: "adminDuplicateCaptureRefundTemplate", render: () =>
    T.adminDuplicateCaptureRefundTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, paymentIntentId: "paymentIntentId-5", settledPaymentIntentId: "settledPaymentIntentId-6", operationReference: "operationReference-7", errorMessage: "errorMessage-8", reviewUrl: "reviewUrl-9", refundFailed: true }) },
  { id: "adminLateCaptureAutoRefundTemplate:minimal", fn: "adminLateCaptureAutoRefundTemplate", render: () =>
    T.adminLateCaptureAutoRefundTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, paymentIntentId: "paymentIntentId-5", bookingId: "bookingId-6", bookingDeleted: true, captureKind: "modification", reviewUrl: "reviewUrl-7" }) },
  { id: "adminLateCaptureAutoRefundTemplate:full", fn: "adminLateCaptureAutoRefundTemplate", render: () =>
    T.adminLateCaptureAutoRefundTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, paymentIntentId: "paymentIntentId-5", bookingId: "bookingId-6", bookingDeleted: true, captureKind: "primary", reviewUrl: "reviewUrl-7" }) },
  { id: "adminLateCaptureHandBackConflictTemplate:minimal", fn: "adminLateCaptureHandBackConflictTemplate", render: () =>
    T.adminLateCaptureHandBackConflictTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, paymentIntentId: "paymentIntentId-5", bookingId: "bookingId-6", bookingDeleted: true, captureKind: "modification", handBackAmountCents: 107, refundSent: true, reviewUrl: "reviewUrl-8" }) },
  { id: "adminLateCaptureHandBackConflictTemplate:full", fn: "adminLateCaptureHandBackConflictTemplate", render: () =>
    T.adminLateCaptureHandBackConflictTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, paymentIntentId: "paymentIntentId-5", bookingId: "bookingId-6", bookingDeleted: true, captureKind: "primary", handBackAmountCents: 107, refundSent: true, reviewUrl: "reviewUrl-8" }) },
  { id: "adminManualSettlementConflictTemplate:minimal", fn: "adminManualSettlementConflictTemplate", render: () =>
    T.adminManualSettlementConflictTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), amountCents: 104, bookingId: "bookingId-5", bookingStatus: "bookingStatus-6", xeroInvoiceNumber: "xeroInvoiceNumber-7", xeroInvoiceUrl: "xeroInvoiceUrl-8", reviewUrl: "reviewUrl-9" }) },
  { id: "adminManualRefundTaskTemplate:minimal", fn: "adminManualRefundTaskTemplate", render: () =>
    T.adminManualRefundTaskTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), refundAmountCents: 104, bookingId: "bookingId-5", reason: "reason-6", reviewUrl: "reviewUrl-7" }) },
  { id: "adminPendingDeadlineTemplate:minimal", fn: "adminPendingDeadlineTemplate", render: () =>
    T.adminPendingDeadlineTemplate([{ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, deadline: new Date("2026-03-06T00:00:00.000Z"), hoursRemaining: 106 }]) },
  { id: "adminBookingBumpedTemplate:minimal", fn: "adminBookingBumpedTemplate", render: () =>
    T.adminBookingBumpedTemplate({ bumpedMemberName: "bumpedMemberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, triggeringMemberName: "triggeringMemberName-5" }) },
  { id: "adminXeroSyncErrorTemplate:minimal", fn: "adminXeroSyncErrorTemplate", render: () =>
    T.adminXeroSyncErrorTemplate({ errorType: "errorType-1", operation: "operation-2", errorMessage: "errorMessage-3", timestamp: new Date("2026-03-05T00:00:00.000Z") }) },
  { id: "adminXeroRepeatedFailureTemplate:minimal", fn: "adminXeroRepeatedFailureTemplate", render: () =>
    T.adminXeroRepeatedFailureTemplate({ correlationKey: "correlation-1", failureCount: 102, windowHours: 103, entityType: "entityType-4", operationType: "operationType-5", localModel: "localModel-6", localId: "localId-7", localUrl: "localUrl-8", xeroObjectUrl: "xeroObjectUrl-9", latestErrorMessage: "latestErrorMessage-10", timestamp: new Date("2026-03-12T00:00:00.000Z") }) },
  { id: "adminCapacityWarningTemplate:minimal", fn: "adminCapacityWarningTemplate", render: () =>
    T.adminCapacityWarningTemplate([{ date: new Date("2026-03-02T00:00:00.000Z"), occupiedBeds: 102, availableBeds: 103 }]) },
  { id: "adminCapacityWarningTemplate:full", fn: "adminCapacityWarningTemplate", render: () =>
    T.adminCapacityWarningTemplate([{ date: new Date("2026-03-02T00:00:00.000Z"), occupiedBeds: 102, availableBeds: 103 }], 12, "lodgeName-4") },
  { id: "bulkCommunicationTemplate:minimal", fn: "bulkCommunicationTemplate", render: () =>
    T.bulkCommunicationTemplate("subject-1", "body-2") },
  { id: "noticePublishedTemplate:minimal", fn: "noticePublishedTemplate", render: () =>
    T.noticePublishedTemplate("firstName-1", "noticeTitle-2", "noticeUrl-3") },
  { id: "adminDailyDigestTemplate:minimal", fn: "adminDailyDigestTemplate", render: () =>
    T.adminDailyDigestTemplate({ newBookings: 101, paymentFailures: 102, capacityWarnings: 103, bookingsBumped: 104, pendingDeadlines: 105, xeroErrors: 106, totalAlerts: 107 }) },
  { id: "adminXeroReconciliationReportTemplate:minimal", fn: "adminXeroReconciliationReportTemplate", render: () =>
    T.adminXeroReconciliationReportTemplate(XERO_REPORT_MINIMAL) },
  { id: "adminXeroReconciliationReportTemplate:full", fn: "adminXeroReconciliationReportTemplate", render: () =>
    T.adminXeroReconciliationReportTemplate(XERO_REPORT_FULL) },
  { id: "adminCreditSyncDriftTemplate:minimal", fn: "adminCreditSyncDriftTemplate", render: () =>
    T.adminCreditSyncDriftTemplate(CREDIT_DRIFT_MINIMAL) },
  { id: "adminCreditSyncDriftTemplate:full", fn: "adminCreditSyncDriftTemplate", render: () =>
    T.adminCreditSyncDriftTemplate(CREDIT_DRIFT_FULL) },
  { id: "bookingModificationSummaryRows:minimal", fn: "bookingModificationSummaryRows", render: () =>
    json(T.bookingModificationSummaryRows({ oldCheckIn: new Date("2026-03-02T00:00:00.000Z"), oldCheckOut: new Date("2026-03-03T00:00:00.000Z"), newCheckIn: new Date("2026-03-04T00:00:00.000Z"), newCheckOut: new Date("2026-03-05T00:00:00.000Z"), oldGuestCount: 105, newGuestCount: 106, oldFinalPriceCents: 107, newFinalPriceCents: 108, changeFeeCents: 109 })) },
  { id: "bookingModificationSummaryRows:full", fn: "bookingModificationSummaryRows", render: () =>
    json(T.bookingModificationSummaryRows({ oldCheckIn: new Date("2026-03-02T00:00:00.000Z"), oldCheckOut: new Date("2026-03-03T00:00:00.000Z"), newCheckIn: new Date("2026-03-04T00:00:00.000Z"), newCheckOut: new Date("2026-03-05T00:00:00.000Z"), oldGuestCount: 105, newGuestCount: 106, oldFinalPriceCents: 107, newFinalPriceCents: 108, changeFeeCents: 109, promoCoverageNote: "promoCoverageNote-10" })) },
  { id: "bookingModificationTypeLabel:minimal", fn: "bookingModificationTypeLabel", render: () =>
    T.bookingModificationTypeLabel("modificationType-1") },
  { id: "bookingModifiedTemplate:minimal", fn: "bookingModifiedTemplate", render: () =>
    T.bookingModifiedTemplate({ firstName: "firstName-1", modificationType: "modificationType-2", oldCheckIn: new Date("2026-03-04T00:00:00.000Z"), oldCheckOut: new Date("2026-03-05T00:00:00.000Z"), newCheckIn: new Date("2026-03-06T00:00:00.000Z"), newCheckOut: new Date("2026-03-07T00:00:00.000Z"), oldGuestCount: 107, newGuestCount: 108, oldFinalPriceCents: 109, newFinalPriceCents: 110, changeFeeCents: 111, refundAmountCents: 112, additionalAmountCents: 113 }) },
  { id: "bookingModifiedTemplate:full", fn: "bookingModifiedTemplate", render: () =>
    T.bookingModifiedTemplate({ firstName: "firstName-1", modificationType: "modificationType-2", oldCheckIn: new Date("2026-03-04T00:00:00.000Z"), oldCheckOut: new Date("2026-03-05T00:00:00.000Z"), newCheckIn: new Date("2026-03-06T00:00:00.000Z"), newCheckOut: new Date("2026-03-07T00:00:00.000Z"), oldGuestCount: 107, newGuestCount: 108, oldFinalPriceCents: 109, newFinalPriceCents: 110, changeFeeCents: 111, refundAmountCents: 112, accountCreditAmountCents: 113, additionalAmountCents: 114, additionalPaymentMethod: "INTERNET_BANKING", paymentReference: "paymentReference-15", xeroInvoiceNumber: "xeroInvoiceNumber-16", promoCoverageNote: "promoCoverageNote-17" }) },
  { id: "accountDeletionApprovedTemplate:minimal", fn: "accountDeletionApprovedTemplate", render: () =>
    T.accountDeletionApprovedTemplate("firstName-1") },
  { id: "familyGroupInvitationTemplate:minimal", fn: "familyGroupInvitationTemplate", render: () =>
    T.familyGroupInvitationTemplate("inviterName-1", "groupName-2", "profileUrl-3") },
  { id: "familyGroupInviteAcceptedTemplate:minimal", fn: "familyGroupInviteAcceptedTemplate", render: () =>
    T.familyGroupInviteAcceptedTemplate("inviteeName-1", "groupName-2") },
  { id: "childRequestSubmittedTemplate:minimal", fn: "childRequestSubmittedTemplate", render: () =>
    T.childRequestSubmittedTemplate("parentName-1", "childName-2", "groupName-3") },
  { id: "childRequestApprovedTemplate:minimal", fn: "childRequestApprovedTemplate", render: () =>
    T.childRequestApprovedTemplate("parentName-1", "childName-2", "groupName-3") },
  { id: "childRequestRejectedTemplate:minimal", fn: "childRequestRejectedTemplate", render: () =>
    T.childRequestRejectedTemplate("parentName-1", "childName-2") },
  { id: "childRequestRejectedTemplate:full", fn: "childRequestRejectedTemplate", render: () =>
    T.childRequestRejectedTemplate("parentName-1", "childName-2", "reason-3") },
  { id: "adminFamilyGroupRequestTemplate:minimal", fn: "adminFamilyGroupRequestTemplate", render: () =>
    T.adminFamilyGroupRequestTemplate({ requestType: "requestType-1", requesterName: "requesterName-2", groupName: "groupName-3", details: "details-4" }) },
  { id: "joinRequestConfirmationTemplate:minimal", fn: "joinRequestConfirmationTemplate", render: () =>
    T.joinRequestConfirmationTemplate("requesterName-1", "groupName-2") },
  { id: "groupCreateRequestConfirmationTemplate:minimal", fn: "groupCreateRequestConfirmationTemplate", render: () =>
    T.groupCreateRequestConfirmationTemplate("requesterName-1", "groupName-2") },
  { id: "groupCreateApprovedTemplate:minimal", fn: "groupCreateApprovedTemplate", render: () =>
    T.groupCreateApprovedTemplate("requesterName-1", "groupName-2") },
  { id: "groupCreateRejectedTemplate:minimal", fn: "groupCreateRejectedTemplate", render: () =>
    T.groupCreateRejectedTemplate("requesterName-1", "groupName-2") },
  { id: "groupCreateRejectedTemplate:full", fn: "groupCreateRejectedTemplate", render: () =>
    T.groupCreateRejectedTemplate("requesterName-1", "groupName-2", "reason-3") },
  { id: "partnerInviteTemplate:minimal", fn: "partnerInviteTemplate", render: () =>
    T.partnerInviteTemplate({ inviterName: "inviterName-1", groupName: "groupName-2", claimUrl: "claimUrl-3", expiresAt: new Date("2026-03-05T00:00:00.000Z") }) },
  { id: "partnerInviteClaimedTemplate:minimal", fn: "partnerInviteClaimedTemplate", render: () =>
    T.partnerInviteClaimedTemplate("firstName-1", "groupName-2") },
  { id: "partnerLinkRequestTemplate:minimal", fn: "partnerLinkRequestTemplate", render: () =>
    T.partnerLinkRequestTemplate("requesterName-1", "profileUrl-2") },
  { id: "partnerLinkConfirmedTemplate:minimal", fn: "partnerLinkConfirmedTemplate", render: () =>
    T.partnerLinkConfirmedTemplate("partnerName-1") },
  { id: "partnerLinkRemovedTemplate:minimal", fn: "partnerLinkRemovedTemplate", render: () =>
    T.partnerLinkRemovedTemplate("partnerName-1") },
  { id: "membershipCancellationSubmittedTemplate:minimal", fn: "membershipCancellationSubmittedTemplate", render: () =>
    T.membershipCancellationSubmittedTemplate({ firstName: "firstName-1", participantSummary: "participantSummary-2", reviewUrl: "reviewUrl-3" }) },
  { id: "membershipCancellationSubmittedTemplate:full", fn: "membershipCancellationSubmittedTemplate", render: () =>
    T.membershipCancellationSubmittedTemplate({ firstName: "firstName-1", participantSummary: "participantSummary-2", reason: "reason-3", reviewUrl: "reviewUrl-4" }) },
  { id: "membershipCancellationConfirmationTemplate:minimal", fn: "membershipCancellationConfirmationTemplate", render: () =>
    T.membershipCancellationConfirmationTemplate({ firstName: "firstName-1", requesterName: "requesterName-2", participantName: "participantName-3", confirmationUrl: "confirmationUrl-4", expiresAt: new Date("2026-03-06T00:00:00.000Z") }) },
  { id: "adminMembershipCancellationRequestTemplate:minimal", fn: "adminMembershipCancellationRequestTemplate", render: () =>
    T.adminMembershipCancellationRequestTemplate({ requesterName: "requesterName-1", participantSummary: "participantSummary-2", reviewUrl: "reviewUrl-3" }) },
  { id: "adminMembershipCancellationRequestTemplate:full", fn: "adminMembershipCancellationRequestTemplate", render: () =>
    T.adminMembershipCancellationRequestTemplate({ requesterName: "requesterName-1", participantSummary: "participantSummary-2", reason: "reason-3", reviewUrl: "reviewUrl-4" }) },
  { id: "adminMemberArchiveRequestedTemplate:minimal", fn: "adminMemberArchiveRequestedTemplate", render: () =>
    T.adminMemberArchiveRequestedTemplate({ requesterName: "requesterName-1", memberName: "memberName-2", reason: "reason-3", reviewUrl: "reviewUrl-4" }) },
  { id: "memberArchiveApprovedTemplate:minimal", fn: "memberArchiveApprovedTemplate", render: () =>
    T.memberArchiveApprovedTemplate({ firstName: "firstName-1", reason: "reason-2" }) },
  { id: "memberArchiveApprovedTemplate:full", fn: "memberArchiveApprovedTemplate", render: () =>
    T.memberArchiveApprovedTemplate({ firstName: "firstName-1", reason: "reason-2", reviewNote: "reviewNote-3" }) },
  { id: "memberArchiveRejectedTemplate:minimal", fn: "memberArchiveRejectedTemplate", render: () =>
    T.memberArchiveRejectedTemplate({ firstName: "firstName-1", reason: "reason-2" }) },
  { id: "memberArchiveRejectedTemplate:full", fn: "memberArchiveRejectedTemplate", render: () =>
    T.memberArchiveRejectedTemplate({ firstName: "firstName-1", reason: "reason-2", reviewNote: "reviewNote-3" }) },
  { id: "adminMemberDeleteRequestedTemplate:minimal", fn: "adminMemberDeleteRequestedTemplate", render: () =>
    T.adminMemberDeleteRequestedTemplate({ requesterName: "requesterName-1", memberName: "memberName-2", reason: "reason-3", reviewUrl: "reviewUrl-4" }) },
  { id: "adminMemberDeleteApprovedTemplate:minimal", fn: "adminMemberDeleteApprovedTemplate", render: () =>
    T.adminMemberDeleteApprovedTemplate({ requesterName: "requesterName-1", memberName: "memberName-2", reason: "reason-3" }) },
  { id: "adminMemberDeleteApprovedTemplate:full", fn: "adminMemberDeleteApprovedTemplate", render: () =>
    T.adminMemberDeleteApprovedTemplate({ requesterName: "requesterName-1", memberName: "memberName-2", reason: "reason-3", reviewNote: "reviewNote-4" }) },
  { id: "adminMemberDeleteRejectedTemplate:minimal", fn: "adminMemberDeleteRejectedTemplate", render: () =>
    T.adminMemberDeleteRejectedTemplate({ requesterName: "requesterName-1", memberName: "memberName-2", reason: "reason-3", reviewUrl: "reviewUrl-4" }) },
  { id: "adminMemberDeleteRejectedTemplate:full", fn: "adminMemberDeleteRejectedTemplate", render: () =>
    T.adminMemberDeleteRejectedTemplate({ requesterName: "requesterName-1", memberName: "memberName-2", reason: "reason-3", reviewNote: "reviewNote-4", reviewUrl: "reviewUrl-5" }) },
  { id: "membershipCancellationApprovedTemplate:minimal", fn: "membershipCancellationApprovedTemplate", render: () =>
    T.membershipCancellationApprovedTemplate({ firstName: "firstName-1", participantName: "participantName-2" }) },
  { id: "membershipCancellationApprovedTemplate:full", fn: "membershipCancellationApprovedTemplate", render: () =>
    T.membershipCancellationApprovedTemplate({ firstName: "firstName-1", participantName: "participantName-2", reason: "reason-3", adminNote: "adminNote-4", rejoinProcessText: "rejoinProcessText-5" }) },
  { id: "membershipCancellationRejectedTemplate:minimal", fn: "membershipCancellationRejectedTemplate", render: () =>
    T.membershipCancellationRejectedTemplate({ firstName: "firstName-1", participantName: "participantName-2" }) },
  { id: "membershipCancellationRejectedTemplate:full", fn: "membershipCancellationRejectedTemplate", render: () =>
    T.membershipCancellationRejectedTemplate({ firstName: "firstName-1", participantName: "participantName-2", reason: "reason-3", adminNote: "adminNote-4" }) },
  { id: "adminMembershipApplicationPendingTemplate:minimal", fn: "adminMembershipApplicationPendingTemplate", render: () =>
    T.adminMembershipApplicationPendingTemplate({ applicantName: "applicantName-1", applicantEmail: "applicantEmail-2", familyMemberCount: 103, reviewUrl: "reviewUrl-4" }) },
  { id: "adminAccountDeletionRequestedTemplate:minimal", fn: "adminAccountDeletionRequestedTemplate", render: () =>
    T.adminAccountDeletionRequestedTemplate({ memberName: "memberName-1", memberEmail: "memberEmail-2", reviewUrl: "reviewUrl-3" }) },
  { id: "adminAccountDeletionRequestedTemplate:full", fn: "adminAccountDeletionRequestedTemplate", render: () =>
    T.adminAccountDeletionRequestedTemplate({ memberName: "memberName-1", memberEmail: "memberEmail-2", reason: "reason-3", reviewUrl: "reviewUrl-4" }) },
  { id: "membershipApplicationApprovedTemplate:minimal", fn: "membershipApplicationApprovedTemplate", render: () =>
    T.membershipApplicationApprovedTemplate("firstName-1", "resetUrl-2") },
  { id: "membershipApplicationApprovedTemplate:full", fn: "membershipApplicationApprovedTemplate", render: () =>
    T.membershipApplicationApprovedTemplate("firstName-1", "resetUrl-2", "adminNotes-3") },
  { id: "membershipApplicationRejectedTemplate:minimal", fn: "membershipApplicationRejectedTemplate", render: () =>
    T.membershipApplicationRejectedTemplate("firstName-1") },
  { id: "membershipApplicationRejectedTemplate:full", fn: "membershipApplicationRejectedTemplate", render: () =>
    T.membershipApplicationRejectedTemplate("firstName-1", "adminNotes-2") },
  { id: "ageUpInvitationTemplate:minimal", fn: "ageUpInvitationTemplate", render: () =>
    T.ageUpInvitationTemplate("firstName-1", "resetUrl-2") },
  { id: "ageUpInvitationTemplate:full", fn: "ageUpInvitationTemplate", render: () =>
    T.ageUpInvitationTemplate("firstName-1", "resetUrl-2", { targetAgeTierLabel: "Adult (18+)" }) },
  { id: "ageUpParentEmailHandoffTemplate:minimal", fn: "ageUpParentEmailHandoffTemplate", render: () =>
    T.ageUpParentEmailHandoffTemplate({ recipientName: "Pat Parent", memberFirstName: "Sam", memberLastName: "Youth" }) },
  { id: "ageUpParentEmailHandoffTemplate:full", fn: "ageUpParentEmailHandoffTemplate", render: () =>
    T.ageUpParentEmailHandoffTemplate({ recipientName: "Pat Parent", memberFirstName: "Sam", memberLastName: "Youth", targetAgeTierLabel: "Adult (18+)" }) },
  { id: "accountDeletionRejectedTemplate:minimal", fn: "accountDeletionRejectedTemplate", render: () =>
    T.accountDeletionRejectedTemplate("firstName-1", "adminNote-2") },
  { id: "waitlistConfirmationTemplate:minimal", fn: "waitlistConfirmationTemplate", render: () =>
    T.waitlistConfirmationTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, 105) },
  { id: "waitlistOfferTemplate:minimal", fn: "waitlistOfferTemplate", render: () =>
    T.waitlistOfferTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, new Date("2026-03-06T00:00:00.000Z"), "bookingId-6", 107) },
  { id: "waitlistOfferTemplate:full", fn: "waitlistOfferTemplate", render: () =>
    T.waitlistOfferTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104, new Date("2026-03-06T00:00:00.000Z"), "bookingId-6", 107, { lodgeName: "lodgeName-8" }, "subscriptionMemberRateNotice-9") },
  { id: "waitlistOfferExpiredTemplate:minimal", fn: "waitlistOfferExpiredTemplate", render: () =>
    T.waitlistOfferExpiredTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104) },
  { id: "waitlistPlaceRestoredTemplate:minimal", fn: "waitlistPlaceRestoredTemplate", render: () =>
    T.waitlistPlaceRestoredTemplate("firstName-1", new Date("2026-03-03T00:00:00.000Z"), new Date("2026-03-04T00:00:00.000Z"), 104) },
  { id: "adminWaitlistOfferTemplate:minimal", fn: "adminWaitlistOfferTemplate", render: () =>
    T.adminWaitlistOfferTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, position: 105 }) },
  { id: "setupIntentFailedTemplate:minimal", fn: "setupIntentFailedTemplate", render: () =>
    T.setupIntentFailedTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z") }) },
  { id: "adminRefundRequestTemplate:minimal", fn: "adminRefundRequestTemplate", render: () =>
    T.adminRefundRequestTemplate({ memberName: "memberName-1", bookingId: "bookingId-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), reason: "reason-5", requestedAmountCents: 106, paidAmountCents: 107, refundedAmountCents: 108 }) },
  { id: "adminBookingChangeRequestTemplate:minimal", fn: "adminBookingChangeRequestTemplate", render: () =>
    T.adminBookingChangeRequestTemplate({ memberName: "memberName-1", memberEmail: "memberEmail-2", bookingId: "bookingId-3", checkIn: new Date("2026-03-05T00:00:00.000Z"), checkOut: new Date("2026-03-06T00:00:00.000Z"), requestedSummary: "requestedSummary-6", reason: "reason-7", reviewUrl: "reviewUrl-8" }) },
  { id: "adminIssueReportTemplate:minimal", fn: "adminIssueReportTemplate", render: () =>
    T.adminIssueReportTemplate({ memberName: "memberName-1", memberEmail: "memberEmail-2", pageUrl: "pageUrl-3", description: "description-4", issueReportUrl: "issueReportUrl-5", hasScreenshot: true }) },
  { id: "adminIssueReportTemplate:full", fn: "adminIssueReportTemplate", render: () =>
    T.adminIssueReportTemplate({ memberName: "memberName-1", memberEmail: "memberEmail-2", pageUrl: "pageUrl-3", pageTitle: "pageTitle-4", description: "description-5", issueReportUrl: "issueReportUrl-6", hasScreenshot: true }) },
  { id: "refundRequestApprovedTemplate:minimal", fn: "refundRequestApprovedTemplate", render: () =>
    T.refundRequestApprovedTemplate({ firstName: "firstName-1", amountCents: 102, adminNotes: "adminNotes-3", checkIn: new Date("2026-03-05T00:00:00.000Z"), checkOut: new Date("2026-03-06T00:00:00.000Z") }) },
  { id: "refundRequestDeclinedTemplate:minimal", fn: "refundRequestDeclinedTemplate", render: () =>
    T.refundRequestDeclinedTemplate({ firstName: "firstName-1", adminNotes: "adminNotes-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z") }) },
  { id: "bookingRequestVerificationTemplate:minimal", fn: "bookingRequestVerificationTemplate", render: () =>
    T.bookingRequestVerificationTemplate({ firstName: "firstName-1", verifyUrl: "verifyUrl-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, expiresAt: new Date("2026-03-07T00:00:00.000Z") }) },
  { id: "groupSettlementReceiptTemplate:minimal", fn: "groupSettlementReceiptTemplate", render: () =>
    T.groupSettlementReceiptTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), joinerCount: 104, totalCents: 105 }) },
  { id: "groupJoinSettledTemplate:minimal", fn: "groupJoinSettledTemplate", render: () =>
    T.groupJoinSettledTemplate({ firstName: "firstName-1", organiserName: "organiserName-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105 }) },
  { id: "groupSettlementExpiredTemplate:minimal", fn: "groupSettlementExpiredTemplate", render: () =>
    T.groupSettlementExpiredTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), joinerCount: 104, totalCents: 105 }) },
  { id: "groupJoinReleasedTemplate:minimal", fn: "groupJoinReleasedTemplate", render: () =>
    T.groupJoinReleasedTemplate({ firstName: "firstName-1", organiserName: "organiserName-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z") }) },
  { id: "groupJoinCancelledTemplate:minimal", fn: "groupJoinCancelledTemplate", render: () =>
    T.groupJoinCancelledTemplate({ firstName: "firstName-1", organiserName: "organiserName-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z") }) },
  { id: "bookingRequestApprovedTemplate:minimal", fn: "bookingRequestApprovedTemplate", render: () =>
    T.bookingRequestApprovedTemplate({ firstName: "firstName-1", payUrl: "payUrl-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, priceCents: 106, expiresAt: new Date("2026-03-08T00:00:00.000Z") }) },
  { id: "splitGuestPaymentLinkTemplate:minimal", fn: "splitGuestPaymentLinkTemplate", render: () =>
    T.splitGuestPaymentLinkTemplate({ firstName: "firstName-1", payUrl: "payUrl-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, priceCents: 106, expiresAt: new Date("2026-03-08T00:00:00.000Z") }) },
  { id: "bookingRequestQuoteTemplate:minimal", fn: "bookingRequestQuoteTemplate", render: () =>
    T.bookingRequestQuoteTemplate({ firstName: "firstName-1", respondUrl: "respondUrl-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, options: [{ label: "label-6", totalCents: 107 }], expiresAt: new Date("2026-03-09T00:00:00.000Z") }) },
  { id: "bookingRequestQuoteTemplate:full", fn: "bookingRequestQuoteTemplate", render: () =>
    T.bookingRequestQuoteTemplate({ firstName: "firstName-1", respondUrl: "respondUrl-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, options: [{ label: "label-6", totalCents: 107 }], message: "message-8", expiresAt: new Date("2026-03-10T00:00:00.000Z"), schoolName: "schoolName-10", isReminder: true }) },
  { id: "bookingRequestDeclinedTemplate:minimal", fn: "bookingRequestDeclinedTemplate", render: () =>
    T.bookingRequestDeclinedTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z") }) },
  { id: "bookingRequestDeclinedTemplate:full", fn: "bookingRequestDeclinedTemplate", render: () =>
    T.bookingRequestDeclinedTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), reason: "reason-4" }) },
  { id: "bookingRequestPaymentExpiredTemplate:minimal", fn: "bookingRequestPaymentExpiredTemplate", render: () =>
    T.bookingRequestPaymentExpiredTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z") }) },
  { id: "adminBookingRequestPendingTemplate:minimal", fn: "adminBookingRequestPendingTemplate", render: () =>
    T.adminBookingRequestPendingTemplate({ requesterName: "requesterName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, reviewUrl: "reviewUrl-5" }) },
  { id: "adminSchoolManualInvoiceTemplate:minimal", fn: "adminSchoolManualInvoiceTemplate", render: () =>
    T.adminSchoolManualInvoiceTemplate({ schoolName: "schoolName-1", contactEmail: "contactEmail-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, totalCents: 106, reviewUrl: "reviewUrl-7" }) },
  { id: "adminWholeLodgeManualInvoiceTemplate:minimal", fn: "adminWholeLodgeManualInvoiceTemplate", render: () =>
    T.adminWholeLodgeManualInvoiceTemplate({ memberName: "memberName-1", contactEmail: "contactEmail-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, totalCents: 106, paymentReference: "paymentReference-7", reviewUrl: "reviewUrl-8" }) },
  { id: "adminWholeLodgeManualInvoiceTemplate:full", fn: "adminWholeLodgeManualInvoiceTemplate", render: () =>
    T.adminWholeLodgeManualInvoiceTemplate({ memberName: "memberName-1", contactEmail: "contactEmail-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), guestCount: 105, totalCents: 106, appliedCreditCents: 107, paymentReference: "paymentReference-8", reviewUrl: "reviewUrl-9" }) },
  { id: "adminBookingRequestHoldExpiredTemplate:minimal", fn: "adminBookingRequestHoldExpiredTemplate", render: () =>
    T.adminBookingRequestHoldExpiredTemplate({ requesterName: "requesterName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, totalCents: 105, holdUntil: new Date("2026-03-07T00:00:00.000Z"), reviewUrl: "reviewUrl-7" }) },
  { id: "adminBookingRequestHoldCancelledTemplate:minimal", fn: "adminBookingRequestHoldCancelledTemplate", render: () =>
    T.adminBookingRequestHoldCancelledTemplate({ requesterName: "requesterName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, totalCents: 105, reviewUrl: "reviewUrl-6" }) },
  { id: "adminSplitSettlementUnpaidTemplate:minimal", fn: "adminSplitSettlementUnpaidTemplate", render: () =>
    T.adminSplitSettlementUnpaidTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, totalCents: 105, holdUntil: new Date("2026-03-07T00:00:00.000Z"), reviewUrl: "reviewUrl-7", parentUnpaid: true }) },
  { id: "adminSplitSettlementCancelledTemplate:minimal", fn: "adminSplitSettlementCancelledTemplate", render: () =>
    T.adminSplitSettlementCancelledTemplate({ memberName: "memberName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, totalCents: 105, reviewUrl: "reviewUrl-6", parentUnpaid: true }) },
  { id: "splitGuestPortionCancelledTemplate:minimal", fn: "splitGuestPortionCancelledTemplate", render: () =>
    T.splitGuestPortionCancelledTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), parentConfirmed: true }) },
  { id: "splitGuestPortionCancelledTemplate:full", fn: "splitGuestPortionCancelledTemplate", render: () =>
    T.splitGuestPortionCancelledTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), parentConfirmed: true, parentBookingReference: "parentBookingReference-4" }) },
  { id: "schoolAttendeeConfirmationTemplate:minimal", fn: "schoolAttendeeConfirmationTemplate", render: () =>
    T.schoolAttendeeConfirmationTemplate({ firstName: "firstName-1", schoolName: "schoolName-2", confirmUrl: "confirmUrl-3", checkIn: new Date("2026-03-05T00:00:00.000Z"), checkOut: new Date("2026-03-06T00:00:00.000Z"), guestCount: 106, isReminder: true }) },
  { id: "wholeLodgeGuestNamesReminderTemplate:minimal", fn: "wholeLodgeGuestNamesReminderTemplate", render: () =>
    T.wholeLodgeGuestNamesReminderTemplate({ firstName: "firstName-1", checkIn: new Date("2026-03-03T00:00:00.000Z"), checkOut: new Date("2026-03-04T00:00:00.000Z"), guestCount: 104, unnamedGuestCount: 105, isFinal: true, urgencyNote: "urgencyNote-6" }) },
  { id: "membershipPaymentRecordedTemplate:minimal", fn: "membershipPaymentRecordedTemplate", render: () =>
    T.membershipPaymentRecordedTemplate({ firstName: "firstName-1", seasonYear: 102, amountCents: 103, recordedAt: new Date("2026-03-05T00:00:00.000Z") }) },
  { id: "memberGuestConsentRequestTemplate:minimal", fn: "memberGuestConsentRequestTemplate", render: () =>
    T.memberGuestConsentRequestTemplate({ firstName: "firstName-1", bookerName: "bookerName-2", askHeading: "askHeading-3", askContextNote: "askContextNote-4", lodgeName: "lodgeName-5", checkIn: new Date("2026-03-07T00:00:00.000Z"), checkOut: new Date("2026-03-08T00:00:00.000Z"), guestNightsLabel: "guestNightsLabel-8", consentExpiresAt: new Date("2026-03-10T00:00:00.000Z"), consentUrl: "consentUrl-10", partyList: { text: "Everyone on this booking\n- Ada Guest", html: "<p>Everyone on this booking</p><ul><li>Ada Guest</li></ul>", names: ["Ada Guest"] } }) },
  { id: "memberGuestConsentRequestTemplate:full", fn: "memberGuestConsentRequestTemplate", render: () =>
    T.memberGuestConsentRequestTemplate({ firstName: "firstName-1", bookerName: "bookerName-2", askHeading: "askHeading-3", askContextNote: "askContextNote-4", lodgeName: "lodgeName-5", checkIn: new Date("2026-03-07T00:00:00.000Z"), checkOut: new Date("2026-03-08T00:00:00.000Z"), guestNightsLabel: "guestNightsLabel-8", consentExpiresAt: new Date("2026-03-10T00:00:00.000Z"), consentUrl: "consentUrl-10", partyList: { text: "Everyone on this booking\n- Ada Guest\n- Bo Member", html: "<p>Everyone on this booking</p><ul><li>Ada Guest</li><li>Bo Member</li></ul>", names: ["Ada Guest", "Bo Member"] } }) },
  { id: "memberGuestAddedTemplate:minimal", fn: "memberGuestAddedTemplate", render: () =>
    T.memberGuestAddedTemplate({ firstName: "firstName-1", addedHeading: "addedHeading-2", addedContextNote: "addedContextNote-3", lodgeName: "lodgeName-4", checkIn: new Date("2026-03-06T00:00:00.000Z"), checkOut: new Date("2026-03-07T00:00:00.000Z"), guestNightsLabel: "guestNightsLabel-7", nightsLabel: "nightsLabel-8", partyList: { text: "Everyone on this booking\n- Ada Guest", html: "<p>Everyone on this booking</p><ul><li>Ada Guest</li></ul>", names: ["Ada Guest"] }, removalNote: "removalNote-9" }) },
  { id: "memberGuestAddedTemplate:full", fn: "memberGuestAddedTemplate", render: () =>
    T.memberGuestAddedTemplate({ firstName: "firstName-1", addedHeading: "addedHeading-2", addedContextNote: "addedContextNote-3", lodgeName: "lodgeName-4", checkIn: new Date("2026-03-06T00:00:00.000Z"), checkOut: new Date("2026-03-07T00:00:00.000Z"), guestNightsLabel: "guestNightsLabel-7", nightsLabel: "nightsLabel-8", partyList: { text: "Everyone on this booking\n- Ada Guest\n- Bo Member", html: "<p>Everyone on this booking</p><ul><li>Ada Guest</li><li>Bo Member</li></ul>", names: ["Ada Guest", "Bo Member"] }, removalNote: "removalNote-9" }) },
  { id: "familyMemberBookingAddedTemplate:minimal", fn: "familyMemberBookingAddedTemplate", render: () =>
    T.familyMemberBookingAddedTemplate({ firstName: "firstName-1", addedHeading: "addedHeading-2", addedContextNote: "addedContextNote-3", lodgeName: "lodgeName-4", checkIn: new Date("2026-03-06T00:00:00.000Z"), checkOut: new Date("2026-03-07T00:00:00.000Z"), removalNote: "removalNote-7" }) },
  { id: "memberGuestConsentOutcomeTemplate:minimal", fn: "memberGuestConsentOutcomeTemplate", render: () =>
    T.memberGuestConsentOutcomeTemplate({ firstName: "firstName-1", outcomeHeading: "outcomeHeading-2", outcomeSentence: "outcomeSentence-3", consequenceNote: "consequenceNote-4", bookingId: "bookingId-5" }) },
  { id: "memberGuestConsentExpiredTemplate:minimal", fn: "memberGuestConsentExpiredTemplate", render: () =>
    T.memberGuestConsentExpiredTemplate({ firstName: "firstName-1", bookerName: "bookerName-2", lodgeName: "lodgeName-3", checkIn: new Date("2026-03-05T00:00:00.000Z"), checkOut: new Date("2026-03-06T00:00:00.000Z") }) },
  { id: "memberGuestRequestWithdrawnTemplate:minimal", fn: "memberGuestRequestWithdrawnTemplate", render: () =>
    T.memberGuestRequestWithdrawnTemplate({ firstName: "firstName-1", withdrawnHeading: "withdrawnHeading-2", withdrawnContextNote: "withdrawnContextNote-3", lodgeName: "lodgeName-4", checkIn: new Date("2026-03-06T00:00:00.000Z"), checkOut: new Date("2026-03-07T00:00:00.000Z") }) },
  { id: "memberGuestConsentAnsweredTemplate:minimal", fn: "memberGuestConsentAnsweredTemplate", render: () =>
    T.memberGuestConsentAnsweredTemplate({ firstName: "firstName-1", answeredHeading: "answeredHeading-2", answeredSentence: "answeredSentence-3", answeredNote: "answeredNote-4" }) },
  { id: "hostingCoverageLostTemplate:minimal", fn: "hostingCoverageLostTemplate", render: () =>
    T.hostingCoverageLostTemplate({ firstName: "firstName-1", lodgeName: "lodgeName-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), uncoveredNights: "uncoveredNights-5" }) },
  { id: "policyExceptionRequestExpiredTemplate:minimal", fn: "policyExceptionRequestExpiredTemplate", render: () =>
    T.policyExceptionRequestExpiredTemplate({ firstName: "firstName-1", lodgeName: "lodgeName-2", checkIn: new Date("2026-03-04T00:00:00.000Z"), checkOut: new Date("2026-03-05T00:00:00.000Z"), expiresAt: new Date("2026-03-06T00:00:00.000Z") }) },
];

export const EMAIL_RENDER_CASES: EmailRenderCase[] = [
  ...GENERATED_CASES,
  ...MONEY_BRANCH_CASES,
];
