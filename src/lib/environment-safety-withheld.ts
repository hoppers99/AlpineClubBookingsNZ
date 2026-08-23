/**
 * How much application email this installation has held back for
 * environment-safety reasons, and when the most recent one was (ENV-SAFETY 1,
 * #3034; epic #2986).
 *
 * WHY A COUNT IS THE SIGNAL, when nothing about the DATA can be one. The one
 * hole this epic cannot close by configuration is a live club installation that
 * is not sending: the production deploy refuses a `.env` saying `non-production`,
 * and it asks each container what it actually received before the cutover, but a
 * site somebody brings up by hand with `docker compose up` runs none of that. It
 * comes up, resolves NON_PRODUCTION or UNKNOWN, and holds back mail its members
 * are waiting for.
 *
 * BOTH of those states hold delivery back, so both surfaces render this line for
 * both. UNKNOWN is if anything the likelier one, because it is what an existing
 * live installation reaches simply by upgrading without adding the declaration.
 *
 * The tempting detector — "warn when the database looks like a real club's
 * records" — cannot work, and it is worth writing down why so nobody builds it.
 * A staging copy is RESTORED from production, so it contains exactly those
 * records; the check would fire on every legitimate copy, which is the common
 * case, and a gate that cries wolf trains its reader to ignore it. It also
 * contradicts the premise of #2986, which is that a copy is indistinguishable
 * from the real thing by inspecting its data.
 *
 * WHAT DOES DISTINGUISH THEM IS CONSEQUENCE. A real club wrongly declared a copy
 * holds back a steady stream of member mail — confirmations, payment notices,
 * renewal reminders — hour after hour. A genuine copy nobody is using holds back
 * almost nothing. So the COUNT, and how recent the most recent one is, separates
 * the two cases where no property of the data can. It is also simply what an
 * operator needs to see either way: *you are not sending mail, and this is how
 * much*.
 *
 * THE NUMBER DOES NOT EXIST YET, AND THAT IS TYPED RATHER THAN FUDGED. The rows
 * it counts are the safety-suppressed email records that
 * **#3035** creates when it puts the delivery boundary in. Until that lands this
 * module answers `{ available: false }`, and both surfaces render a sentence
 * saying the counting is not in place yet. That distinction is the point: "nothing
 * has been held back" and "we cannot count yet" look identical on a screen and
 * mean opposite things — one says the copy is idle, the other says we do not
 * know. Nothing here counts a stand-in from some other table, because a number
 * that measures the wrong thing is worse than an honest absence.
 *
 * **#3035's wiring point is {@link readWithheldApplicationEmail}** and nothing
 * else: replace its body with the real aggregate and every surface below starts
 * reporting. The shape is fixed now so that is all it has to do.
 */

/**
 * The summary, in the three states a reader has to be able to tell apart.
 *
 * `available: false` is not an error and not a zero. It is "this installation
 * does not record what it holds back yet", which is the state every installation
 * is in until #3035 ships.
 */
export type WithheldApplicationEmail =
  | { available: false }
  | {
      available: true;
      /** How many application messages were held back for safety reasons. */
      count: number;
      /** ISO instant of the most recent, or `null` when the count is 0. */
      mostRecentAt: string | null;
    };

/** The answer every installation gives until #3035 records the rows. */
export const WITHHELD_APPLICATION_EMAIL_NOT_RECORDED: WithheldApplicationEmail = {
  available: false,
};

/**
 * Read the summary.
 *
 * **THIS IS #3035's WIRING POINT.** It is deliberately `async` and deliberately
 * database-free today: making it async now means #3035 changes this body and
 * nothing else — no caller signature, no surface, no test harness. Returning a
 * fabricated zero instead would be worse than useless, because a zero reads as
 * "this copy has held nothing back", which is the very reassurance an operator
 * must not be given on a live site that has been wrongly declared a copy.
 */
export async function readWithheldApplicationEmail(): Promise<WithheldApplicationEmail> {
  return WITHHELD_APPLICATION_EMAIL_NOT_RECORDED;
}
