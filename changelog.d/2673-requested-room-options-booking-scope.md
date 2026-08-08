- **The room-request picker now offers only rooms at the booking's own lodge,
  and works properly for booking officers (#2664).** On a club with more than
  one lodge, the **Room Request** picker on a booking used to list rooms from
  every lodge the person looking at it happened to be allowed to book. Choosing
  one of the other lodge's rooms then failed to save — correctly, because a
  booking's requested room has to be in that booking's own lodge — so the
  control simply looked broken to the member.

  The picker now asks the server what *this booking* may request, and the server
  answers with that booking's lodge's active rooms and nothing else. A room from
  another lodge is never offered, so the refusal that used to follow no longer
  has anything to refuse.

  The same read also fixes the staff side. A Booking Officer editing a booking
  on someone's behalf had their choices filtered — or refused outright — by
  *their own* personal booking restrictions, even though their permission to
  edit the booking came from their officer role. Permission for the picker now
  comes from the booking, exactly as the save already did, so an officer can
  edit a room request at a lodge they would not personally book at.

  Nothing an operator has to do, and nothing about how a saved room request is
  stored or honoured has changed. A room the club has since retired that a
  booking already holds still shows as the value on record, marked inactive, and
  still cannot be picked afresh.
