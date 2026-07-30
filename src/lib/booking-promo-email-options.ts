/**
 * #2267: the promo options a booking-confirmation email needs, read off a
 * booking once.
 *
 * Callers hand-rolled this bag at every confirmation send site, and two of them
 * — the confirm-pending cron and the admin confirm-pending-guests route —
 * carried it verbatim, so a promo shape fixed in one could stay broken in the
 * other. The promo fields are supplied only when the booking actually redeemed
 * a promo code, so a booking without one renders no promo lines at all.
 *
 * Deliberately a standalone, dependency-free module rather than part of the
 * email barrel: it composes data, sends nothing, and tests that stub the email
 * module (to avoid its send machinery) still get the real behaviour here.
 */
export function bookingPromoEmailOptions(booking: {
  lodgeId: string | null;
  discountCents: number;
  promoAdjustmentCents: number;
  promoRedemption?: { promoCode?: { code: string } | null } | null;
}): {
  lodgeId: string | null;
  discountCents?: number;
  promoAdjustmentCents?: number;
  promoCode?: string;
} {
  return {
    lodgeId: booking.lodgeId,
    ...(booking.promoRedemption?.promoCode
      ? {
          discountCents: booking.discountCents,
          promoAdjustmentCents: booking.promoAdjustmentCents,
          promoCode: booking.promoRedemption.promoCode.code,
        }
      : {}),
  };
}
