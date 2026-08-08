- **The preferred-room picker no longer says "Saved" when the club's records
  refused the change (#2654).** The picker on a booking's page saves as soon as
  a room is chosen, and it used to report success without checking whether the
  save had actually worked. Every refusal the system can give — an unknown room,
  a room belonging to another lodge, someone editing a booking that is not
  theirs, and above all a booking whose beds the lodge has already allocated —
  came back as "Saved", with the refused room left showing on screen. The only
  way to discover that nothing had been stored was to reload the page.

  The picker now reports what actually happened. When a change is refused it
  puts the room back to the one the club's records hold and shows the reason in
  the system's own words, so "your beds have been allocated by the lodge and can
  no longer be changed here" reaches the member who needs to read it instead of
  being discarded. If the request never reaches the server at all, it says so
  rather than claiming a save. A successful change now takes the stored room
  from the club's answer, so a room that has since been retired is shown as
  retired rather than as a fresh choice.

  Re-picking the room a booking already has no longer sends anything at all,
  which removes a small stream of pointless entries from the audit log.

  Nothing about how a room request is stored or approved has changed, and no
  existing booking is affected. The identical problem on the **expected arrival
  time** picker is fixed separately (#2621).
