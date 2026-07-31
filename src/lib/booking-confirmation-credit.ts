import { PaymentSource, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deriveBookingAppliedCreditCents } from "@/lib/member-credit";
import type {
  AppliedCreditSummary,
  ConfirmationSettlementMethod,
} from "@/lib/email-templates";

/**
 * #2328: the applied-account-credit facts a booking confirmation must state,
 * read off the booking's OWN PERSISTED RECORDS.
 *
 * Why this exists at all. A member who puts $120.00 of account credit towards a
 * $300.00 stay is charged $180.00, but every confirmation send passed the
 * booking's `finalPriceCents` as the email's total, so the message read
 * "Total Paid: $300.00" with nothing to explain the $120.00 the card never saw.
 * Thirteen call sites across twelve modules had the same hole, and none of them
 * carried the credit figure, because it is recorded somewhere else entirely.
 *
 * Why `sendBookingConfirmedEmail` calls this itself, rather than each send site
 * threading the figure in. Thirteen sites is thirteen chances to forget, and the
 * fourteenth — written next year — would reintroduce the bug silently, because
 * a missing credit line looks exactly like a booking that used no credit. The
 * sender already has the one input this needs (the booking id it is required to
 * be given), and every site calls it AFTER its settlement transaction has
 * committed, so there is nothing a site could tell us that the booking's own
 * rows do not already say more reliably.
 *
 * Why it READS rather than RE-COMPUTES. `calculateBookingCreditApplication`
 * decides what credit to apply at booking time; re-running it at send time
 * would answer "what would we apply now", against a balance and a price that
 * have both moved since. The truth is the ledger:
 * `deriveBookingAppliedCreditCents` sums this booking's `BOOKING_APPLIED` rows
 * — the same derivation the card/Internet-Banking effective-price guards, the
 * #1887 reprice clamp and the $0 settlement all key on — so the email quotes
 * exactly the money the club actually took off the member's balance, including
 * any later clamp offset. See `src/lib/member-credit.ts` for why that sum, and
 * not `Payment.creditAppliedCents`, is the authority.
 *
 * The settlement method comes from the same booking's persisted Payment row, so
 * the second line of the pair ("Paid by card" / "Paid by bank transfer" /
 * "Paid by cash or bank transfer") states how the club was really paid. A
 * manually-recorded cash settlement (#2262) is stored as an ordinary
 * `INTERNET_BANKING` payment with `manuallyMarkedPaidAt` set, so that stamp —
 * never the source alone — is what identifies it.
 *
 * Call this AFTER the settlement transaction has committed (every confirmation
 * send site does), so the ledger rows and the Payment row it reads are the
 * settled ones. A booking with no Payment row yet, or none of this booking's
 * credit spent, degrades to "no credit, card", which renders nothing.
 */
export async function loadBookingAppliedCredit(
  bookingId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<AppliedCreditSummary> {
  const [amountCents, payment] = await Promise.all([
    deriveBookingAppliedCreditCents(bookingId, db),
    db.payment.findUnique({
      where: { bookingId },
      select: { source: true, manuallyMarkedPaidAt: true },
    }),
  ]);

  return {
    amountCents,
    settlementMethod: resolveConfirmationSettlementMethod(payment),
  };
}

/**
 * Pure half of the above, so the three-way mapping is unit-testable away from
 * the database. `null` (no Payment row) falls back to "card": it is the shape
 * every Stripe booking has before its row is written, and the only send that
 * can reach it has taken no bank transfer to describe.
 */
export function resolveConfirmationSettlementMethod(
  payment: { source: PaymentSource; manuallyMarkedPaidAt: Date | null } | null,
): ConfirmationSettlementMethod {
  if (!payment) return "card";
  if (payment.manuallyMarkedPaidAt) return "manual";
  return payment.source === PaymentSource.INTERNET_BANKING
    ? "bank_transfer"
    : "card";
}
