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

  Two smaller safety fixes came with it. Deactivating a bed is now refused while
  **last night's** guest is still in it — they are at the lodge until midday, and
  the old check only looked at tonight onwards. Deleting a bed that has ever held
  a guest now gives a plain refusal naming the occupant and pointing at the bed
  allocation page, instead of the database error it used to raise; deactivate the
  bed instead, which keeps the history.

  Nothing about capacity, pricing or whole-lodge bookings changed — those already
  read the night list correctly, and their behaviour is unchanged night for
  night.
