/**
 * The bed-allocation board's lodge-scope contract, shared by
 * `GET /api/admin/bed-allocation` and the board page that calls it (#2701).
 *
 * It is a module of its own because both ends need the same three facts and
 * neither end can import the other: `admin-bed-allocation.ts` reaches Prisma,
 * so the client page importing it would drag the server into the browser
 * bundle, and the route cannot import a page. Keeping the rule in one place is
 * what lets the board's own test drive a fake server through the SAME predicate
 * the route uses, so "the client never sends a contradictory pair" cannot drift
 * away from what the route actually refuses.
 *
 * Client-safe: no imports, no Prisma, no Next.
 */

/**
 * Machine-readable code on the board's 409 body. Deliberately the same spelling
 * as the writer's own refusal (`BedAllocationMoveConflictCode.LODGE_MISMATCH`
 * in `bed-allocation-move.ts`) — one contradiction, refused the same way at
 * both ends. This is the READ-side backstop; the writer's refusal is untouched
 * and remains the thing that actually protects the data.
 */
export const BOARD_LODGE_MISMATCH_CODE = "LODGE_MISMATCH";

/**
 * What the admin is told. After #2701's selection fixes no honest navigation
 * can produce this pair — the board either sends the booking's own lodge or
 * sends no lodge at all and adopts the one the server derived — so this reads
 * as "this link is wrong", not as "you did something wrong".
 */
export const BOARD_LODGE_MISMATCH_MESSAGE =
  "This link names a booking at one lodge and a board at another, so the board cannot show both. Open the booking again from its own page to get the right lodge.";

/**
 * True when a request names a booking AND a lodge that contradict each other.
 *
 * Both ends must be present: a request with no `lodgeId` is scoped entirely by
 * the booking (the #2678 derivation), and an unresolvable `bookingId` leaves
 * the caller's own scope in force, because a stale deep link must not turn a
 * valid board load into an error.
 */
export function boardLodgeScopeMismatch(
  bookingLodgeId: string | null | undefined,
  requestedLodgeId: string | null | undefined,
): boolean {
  if (!bookingLodgeId || !requestedLodgeId) return false;
  return bookingLodgeId !== requestedLodgeId;
}
