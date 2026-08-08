- **The "Preferred room" choice when making a booking can no longer show
  another lodge's rooms (#2664, create side).** On a club with more than one
  lodge, the optional room preference on the last step of the booking flow could
  end up listing rooms from a different lodge than the one being booked. Picking
  one of those looked fine right up until the booking was submitted, at which
  point it was refused — correctly, because a room preference has to be a room at
  the lodge you are staying at — so the member met a choice the form had offered
  them and then rejected.

  It happened because the page asked "what rooms could this member request?"
  before it had settled which lodge was being booked, and that question answers
  with every lodge the member is allowed to book at. Usually the correct,
  lodge-specific answer arrived afterwards and replaced it; when it arrived
  first, the wrong list stayed on screen for the rest of the visit.

  The page now waits until it knows the lodge and only ever asks about that
  lodge, and an answer that has already been overtaken is discarded instead of
  being allowed to win. This completes the same correction already made to the
  room picker on an existing booking.

  Nothing for an operator to do. Single-lodge clubs were never affected, and no
  saved room preference changes.
