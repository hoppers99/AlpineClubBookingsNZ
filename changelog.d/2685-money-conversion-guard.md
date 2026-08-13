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

  Amounts are also read more exactly. "50abc" is no longer taken as $50, and an
  amount with three decimal places such as $10.005 is refused rather than being
  rounded to a cent nobody chose — including on the joining fee invoice, where
  it previously rounded down. Anything with a currency symbol, a thousands
  separator or a stray character is refused the same way.

  Nothing about how the club's accounting figures are calculated changed. Every
  amount that comes back from Xero converts to exactly the same number of cents
  as before; that conversion simply now happens in one reviewed place rather
  than in twenty-five copies, and a new automated check stops a future change
  from reintroducing either problem.
