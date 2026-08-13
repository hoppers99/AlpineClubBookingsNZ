- **A mistyped amount is now refused with a message instead of being quietly
  saved as nothing (#2685).** Several money boxes in the admin area, and the
  refund appeal form members use, accepted whatever was typed and did their best
  to make a number of it. When they could not, the amount became zero — or
  vanished from the request altogether — and the form saved anyway, with nothing
  on screen to say so.

  In practice that meant a hut nightly rate could be stored as $0.00, a season's
  flat whole-lodge rate could silently revert to per-guest pricing, a
  cancellation fixed fee could become $0.00, a promo code could be saved with no
  discount value, and a member's refund appeal could be filed with no amount
  asked for. Each of those boxes now shows a plain message — "Enter an amount in
  dollars and cents, for example 45.00" — leaves what was typed on screen, and
  refuses to save until it is fixed.

  Making that work meant changing what the boxes themselves are. A money box
  used to be a number field, and a browser silently empties a number field the
  instant its contents stop looking like a number — so "50abc", "$45.00",
  "1,000.00" and "50." never reached the page at all, and the page could only
  see a box that looked deliberately cleared. Money boxes are now ordinary text
  boxes that still bring up a number keypad on a phone, so what was typed
  survives and can be answered. The one thing lost is the little up/down spinner
  arrows on a desktop browser.

  Amounts are also read more exactly. "50abc" is no longer taken as $50, and an
  amount with three decimal places such as $10.005 is refused rather than being
  rounded to a cent nobody chose — including on the joining fee invoice, where
  it previously rounded down. Anything with a currency symbol, a thousands
  separator or a stray character is refused the same way, and the messages now
  say which of those was the problem instead of blaming the amount's size.

  The payments search screen no longer swallows a refusal either. Typing an
  amount the filter cannot read used to leave the previous search's rows on
  screen underneath the new filter, which read as a result. It now clears the
  table and says why, next to the boxes that caused it. And on the cancellation
  policy editor, pressing Cancel or switching to a different lodge now clears
  the boxes properly — half-typed text and its complaint used to survive both,
  which left Save disabled over a policy that had already been put back.

  Nothing about how the club's accounting figures are calculated changed. Every
  amount that comes back from Xero converts to exactly the same number of cents
  as before, including every figure read out of a Xero report; that conversion
  simply now happens in one reviewed place rather than in twenty-five copies,
  and a new automated check stops a future change from reintroducing either
  problem. Two internal safety checks that compare an invoice against what the
  club expected became stricter in one respect: an invoice whose amount cannot
  be read at all is now treated as "does not match" rather than as zero, so it
  is never quietly adopted. No readable invoice is affected.
