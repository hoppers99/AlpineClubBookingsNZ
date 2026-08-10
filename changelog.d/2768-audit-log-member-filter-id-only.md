- **The audit log no longer puts a member's name and email address in the page
  address (#2733).** Filtering the audit log by member used to write that
  member's name and email into the address bar, so they were kept in browser
  history on the admin machine, recorded by any proxy or CDN in front of the
  site, and passed on in the `Referer` header of every link followed out of the
  page — none of which the club's own log redaction can reach.

  The filter now travels as the member's id alone. Sharing or bookmarking a
  filtered view works exactly as before: opening the link looks the member up and
  shows their name on the filter chip.

  An address saved *before* this change still contains the name and email. From
  the first time it is opened the page drops them, so they are not carried on into
  new history entries or into the next page clicked through to — but that is a fix
  going forward, not a clean-up. Opening that bookmark is a visit the browser and
  any proxy in front of the site have already recorded, and nothing the page does
  afterwards can remove those records. Replacing the bookmark is the only way to
  stop it happening again.

  One visible difference for an administrator whose role can read the audit log
  but not the membership roll: the name on the chip is taken from the audit
  entries on screen instead of from the membership roll, and reads "Selected
  member" only when none of the entries on screen names that member. The filter
  itself always works.
