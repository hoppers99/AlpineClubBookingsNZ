- **Two garbled labels now read properly, and the booking edit screen was
  reorganised internally behind them (#2690).** Two places on screen showed the
  raw characters `\u2014` where an em dash was meant. On the booking edit screen
  the partner quick-add button read "Jane Smith \u2014 partner of Bob"; on the
  admin new-booking screen the over-capacity warning read "You can still create
  it \u2014 you will confirm the override at the final step." Both now show a
  normal dash. A check over every screen and browser test in the repository
  found only those two, and it now runs on every change so the class cannot come
  back unnoticed.

  Behind that, the screen that admins and members use to change a booking's
  dates, guests, promo code and account credit had grown into a single
  3,876-line file holding fifty pieces of state and eight background behaviours,
  which made every change to it riskier than it should have been.

  It is now one small shell that composes a component per concern — dates,
  guests, promo code, account credit, price summary, admin override, the admin
  request and the no-adult reason — with the eight background behaviours moved
  into separately named pieces that say what each one does: loading the booking
  owner's family, loading available promo codes, pricing the pending edit,
  re-showing a refused member-guest add, and the four reset rules.

  Apart from those two labels, nothing an operator or member does works
  differently. Fetch timing, the half-second pause before a price is
  recalculated, every reset rule, validation, focus and error behaviour and the
  order things are saved in are all unchanged, and new tests prove the price
  recalculation still runs exactly once per edit, that a slow answer for an edit
  you have moved on from cannot overwrite the current price, and that pressing
  Save twice cannot save twice.

  The repository's file-size ledger records the new size too, so the two
  thousand lines this removed cannot quietly come back.
