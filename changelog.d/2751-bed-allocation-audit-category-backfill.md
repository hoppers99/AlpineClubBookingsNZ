- **Bed-allocation history reads as one run again, however old (#2751).** The
  previous release moved bed allocation out of the **Admin** activity category and
  into **Lodge**, because a bed in a lodge room on a lodge night is lodge work
  whoever moved it. That changed where the platform files a *new* record and
  deliberately left the records already written alone — so the history was split
  at the release date. Filtering **Admin → Audit Log** by Lodge showed the newer
  allocations, filtering by Admin showed the older ones, and neither answered
  "what happened to the beds that weekend" if the weekend straddled the upgrade.

  This upgrade moves the older records too. Filtering by **Lodge** now returns the
  whole run. It rewrites exactly the bed-allocation and lodge-display records whose
  filing changed, matched by their exact event names, and it changes **one field**
  on them: the date, who did it, who it was about, the summary, the stored details
  and the seven-year retention date are all exactly as they were.

  **You will see the upgrade record itself.** One new entry appears, *"Upgrade
  moved historical bed-allocation and lodge-display activity records from the Admin
  category to Lodge"*, filed under **Admin** and carrying how many records were in
  each category before and after. It is there on purpose: this is the club's own
  record that its own history was rewritten, and Admin is the category a
  Support-only operator can still see — so the person who just lost these records
  from their AI Diagnostics view can read why.

  **Who this affects, plainly.** Anyone with Support access still reads every one
  of these records in full in **Admin → Audit Log**, exactly as before — nothing
  is hidden from anyone on that screen. In **AI Diagnostics** the older records
  follow the newer ones: they leave the system correlation tool and join the lodge
  one, so an operator holding Support alone, and a **Booking Officer holding
  Support and Bookings but not Lodge**, no longer correlate them there. That is
  the same narrowing the previous release already applied to new records, now
  applied consistently instead of by date. No member gains or loses sight of
  anything on their own activity page, and no record's retention date moved.

  **One small edge, and what to do about it.** The rewrite runs a few minutes
  before the new version starts serving, so an allocation made during the upgrade
  itself is recorded by the old version and filed the old way. Clear the Category
  filter (or use **All**) if you are chasing something from the upgrade window.
  The upgrade runbook asks whoever performs the upgrade to run the rewrite once
  more afterwards, which removes even those.

  **And it is now the rule rather than a one-off.** A change that moves an event
  from one activity category to another has to move the records already written or
  say in writing why it will not — recorded as `INV-OPS-012`, so the next
  reclassification cannot quietly leave a second split behind.
