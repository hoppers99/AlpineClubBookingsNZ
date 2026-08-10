- **Bookings with a gap in them now behave the same way everywhere (#2628).**
  A guest can be booked in for some nights of a stay but not others — in on
  Friday, home on Saturday, back on Monday. Six different parts of the system
  worked out which nights that meant, and three of them read the booking's
  overall first-and-last dates instead of the actual list of nights, so they
  quietly filled the gap back in.

  Three things an officer could see are fixed as a result. The dashboard's
  "awaiting a bed" count no longer reports such a guest as needing a bed
  forever, because it was counting gap nights nobody will ever allocate. A
  booking with a gap can now reach **Beds: complete** and leave the operational
  queue, instead of sitting there permanently as partly allocated. And at the
  lodge, a guest who leaves and comes back can be marked departed on each
  morning they actually leave — previously only the very last departure could be
  recorded, so the earlier one was shown on the kiosk with no way to check them
  out.

  The kiosk keeps up with them for the rest of the stay too. When such a guest
  comes back, **Mark Arrived** is offered again and records the new arrival,
  clearing the earlier check-out as it does — before this the card was greyed out
  with no button at all on a night the guest was standing at the desk. Checking
  someone out still clears the **suggested** chores they can no longer do, but
  only up to the next night they are booked in for, so a roster prepared for the
  later part of their stay is no longer wiped by an earlier check-out.

  Two smaller safety fixes came with it. Deactivating a bed is now refused while
  **last night's** guest is still in it — they are at the lodge until midday, and
  the old check only looked at tonight onwards. Deleting a bed that has ever held
  a guest now gives a plain refusal naming the occupant and pointing at the bed
  allocation page, instead of the database error it used to raise; deactivate the
  bed instead, which keeps the history. That refusal names the first few dates
  and guests and then says "and more", so a bed with seasons of history gives a
  message an officer can actually read.

  Nothing about capacity, pricing or whole-lodge bookings changed — those already
  read the night list correctly, and their behaviour is unchanged night for
  night.
