- **The preferred-room picker now asks before it saves, and tells the truth
  about what happened (#2654).** The picker on a booking's page used to save as
  soon as a room was chosen, and it reported success without checking whether
  the save had actually worked. Every refusal the system can give — an unknown
  room, a room belonging to another lodge, someone editing a booking that is not
  theirs, and above all a booking whose beds the lodge has already allocated —
  came back as "Saved", with the refused room left showing on screen. The only
  way to discover that nothing had been stored was to reload the page.

  Choosing a room now only proposes it. Nothing is written until you press
  **Save preferred room**, which is the same way the expected-arrival-time
  picker beside it on the same page works, so both controls on a booking behave
  alike. The button stays greyed out until you have actually changed something,
  so re-picking the room a booking already has sends nothing at all — which also
  removes a small stream of pointless entries from the club's audit log.

  When a save is refused the picker says so in the system's own words, so "your
  beds have been allocated by the lodge and can no longer be changed here"
  reaches the member who needs to read it instead of being discarded. The room
  you chose stays on screen so you can try again or pick something else, while
  the club's records are correctly shown as unchanged. If the request never
  reaches the server at all, it says that plainly rather than claiming a save. A
  successful change takes the stored room from the club's answer, so a room that
  has since been retired is shown as retired rather than as a fresh choice.

  Nothing about how a room request is stored or approved has changed, and no
  existing booking is affected. The identical problem on the **expected arrival
  time** picker was fixed separately (#2621).
