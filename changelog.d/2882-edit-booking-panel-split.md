- **The booking edit screen was reorganised internally, with nothing about it
  changing on screen (#2690).** The screen that admins and members use to change
  a booking's dates, guests, promo code and account credit had grown into a
  single 3,876-line file holding fifty pieces of state and eight background
  behaviours, which made every change to it riskier than it should have been.

  It is now one small shell that composes a component per concern — dates,
  guests, promo code, account credit, price summary, admin override, the admin
  request and the no-adult reason — with the eight background behaviours moved
  into separately named pieces that say what each one does: loading the booking
  owner's family, loading available promo codes, pricing the pending edit,
  re-showing a refused member-guest add, and the four reset rules.

  Nothing an operator or member does works differently. Fetch timing, the
  half-second pause before a price is recalculated, every reset rule, validation,
  focus and error behaviour and the order things are saved in are all unchanged,
  and a new test proves the price recalculation still runs exactly once per edit.
