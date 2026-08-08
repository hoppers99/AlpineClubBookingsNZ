- **The "Preferred room" choice when making a booking can no longer show another
  lodge's rooms (#2664).** On a club with more than one lodge, the optional room
  preference on the Review step could list rooms belonging to a different lodge
  than the one being booked. Picking one looked fine until the booking was
  submitted, at which point it was refused — correctly, because a room preference
  has to be a room at the lodge you are staying at — so the member was offered a
  choice and then told it was invalid.

  The page now waits until it knows which lodge is being booked and only ever asks
  about that lodge. This completes the same correction already made to the room
  picker on an existing booking.

  One deliberate change for operators to know about: if the list of lodges cannot
  be loaded, the room preference is now left out of the form rather than filled
  with a guess. Clubs with a single active lodge were effectively unaffected
  throughout, and no saved room preference changes.
