/**
 * How much of the club's Xero accounting this installation has contained
 * (ENV-SAFETY 3, #3036; epic #2986; INV-CONFIG-005).
 *
 * WHY AN OPERATOR NEEDS A NUMBER HERE, and why the role alone is not enough.
 * `/admin/environment` already says which installation this is. What it cannot
 * say from the role is whether this copy has been pointed at the club's REAL
 * Xero organisation — and if it has, containment has rewritten email addresses
 * on real accounting records. That is a destructive edit made for a good reason,
 * and the person who discovers it needs to know how many contacts it touched
 * before they decide what to do about it. So this reports two numbers that mean
 * different things:
 *
 * - **`containedContacts`** — how many Xero contacts this installation has
 *   proved cannot reach a member. On a copy that number climbing is the feature
 *   working.
 * - **`rewrittenContacts`** — the subset where Xero was actually holding a
 *   deliverable address that this installation overwrote. On a copy pointed at a
 *   sandbox Xero organisation that is ordinary. On a copy pointed at the club's
 *   real organisation it is the number that means *act now*, and it is why the
 *   two are not summed.
 *
 * IT REPORTS THE ADDRESS OF NOBODY. The contained address is a SHA-256 of the
 * source address, so even the row it comes from carries no member's email, and
 * this summary carries no address at all — only counts and an instant. The
 * issue asks for exactly that: distinguish production, confirmed non-production
 * containment and environment-unknown blocking "without unnecessarily exposing
 * real email".
 *
 * AN UNREADABLE COUNT IS ITS OWN ANSWER, the same distinction
 * `environment-safety-withheld.ts` makes: "nothing has been contained" and "we
 * could not count" look identical on a screen and mean opposite things. One says
 * this copy has not touched Xero; the other says nobody knows.
 *
 * ZERO IS THE ONLY POSSIBLE ANSWER ON THE LIVE SITE, and that is why no surface
 * shows this number without the effective role beside it. Containment runs only
 * on a confirmed NON_PRODUCTION installation, so a PRODUCTION installation's
 * table stays empty for ever — an empty count there is not reassurance about
 * anything, it is the definition.
 *
 * FAILS SOFT, deliberately: this runs inside an admin page's payload, and a
 * database that cannot answer must not turn the screen into a 500 when
 * `available: false` is a state the screen already renders.
 */

import logger from "@/lib/logger";
import { prisma } from "@/lib/prisma";

/** The summary, in the two states a reader has to be able to tell apart. */
export type XeroContactContainment =
  | { available: false }
  | {
      available: true;
      /** Xero contacts proved unable to reach a member on this installation. */
      containedContacts: number;
      /**
       * The subset where a deliverable address was actually replaced. See the
       * module docblock: this is the number that distinguishes a copy pointed at
       * a sandbox Xero organisation from one pointed at the club's real books.
       */
      rewrittenContacts: number;
      /** ISO instant of the most recent containment, or `null` when there are none. */
      mostRecentAt: string | null;
    };

/** The answer when the count cannot be read at all. */
export const XERO_CONTACT_CONTAINMENT_NOT_RECORDED: XeroContactContainment = {
  available: false,
};

/**
 * Read the summary.
 *
 * ONE `aggregate` PLUS ONE `count`, both over a table holding at most one row per
 * Xero contact — thousands of rows on the largest club, not a log. There is no
 * index beyond the unique key on `xeroContactId` and none is wanted: a sequential
 * scan of a few thousand narrow rows on an administrator's page load is cheaper
 * than a second btree to maintain on every containment write.
 */
export async function readXeroContactContainment(): Promise<XeroContactContainment> {
  try {
    const [all, rewritten] = await Promise.all([
      prisma.xeroSandboxContactContainment.aggregate({
        _count: { _all: true },
        _max: { updatedAt: true },
      }),
      prisma.xeroSandboxContactContainment.count({
        where: { rewroteAddress: true },
      }),
    ]);
    return {
      available: true,
      containedContacts: all._count._all,
      rewrittenContacts: rewritten,
      mostRecentAt: all._max.updatedAt
        ? all._max.updatedAt.toISOString()
        : null,
    };
  } catch (error) {
    logger.error(
      {
        scope: "xero-contact-containment-status",
        err: { message: error instanceof Error ? error.message : String(error) },
      },
      "Could not count the Xero contacts this installation has contained, so the operator surface reports that the number is unavailable rather than reporting a zero. Apply pending migrations (prisma migrate deploy) or restore database access.",
    );
    return XERO_CONTACT_CONTAINMENT_NOT_RECORDED;
  }
}
