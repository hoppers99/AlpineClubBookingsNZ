- **Closed the fault that could silently switch off a promo code's usage cap and
  its discount (#2289).** A handful of places in the system write database
  queries by hand rather than going through the usual data layer. When they do,
  the code has to state what the answer will look like — and nothing ever checked
  that it was right. Where the two disagreed, the missing values did not raise an
  error. They simply came back blank, and blank quietly reads as "no limit" and
  as "no discount".

  That is not theoretical. In one club's installation it meant a promo code's
  "maximum number of redemptions" never took effect, so the code kept working
  after it should have been exhausted; and free-night promotions applied **no**
  discount when a booking was created, even though the quote the member had just
  been shown included one. Members were quoted a discount and then charged
  without it, for months, with nothing appearing in any log.

  **Clubs running this public version were never affected**, and no promo
  behaviour changes for them: this installation's column names have always
  matched what the code expects, so the caps and discounts have always been
  applied correctly. What changes is that the fault can no longer happen at all.
  Every hand-written query that was only reserving a record while it was edited
  now does exactly that and nothing more, and reads the details it needs through
  the ordinary data layer, which knows the real names. The single query that
  genuinely cannot be written any other way — the one behind the limit on how
  often a page or form can be submitted — now checks its own answer and reports a
  problem loudly instead of quietly letting every request through.

  The same protection covers the member photo and club logo screens, where the
  value being read decides which stored image gets deleted.

  For anyone working on the code: a new check refuses this pattern in future, and
  `CONTRIBUTING.md` and the concurrency guide explain what to write instead.
