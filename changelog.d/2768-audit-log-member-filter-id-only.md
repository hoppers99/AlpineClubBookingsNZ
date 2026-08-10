- **The audit log no longer puts a member's name and email address in the page
  address (#2733).** Filtering the audit log by member used to write that
  member's name and email into the address bar, so they were kept in browser
  history on the admin machine, recorded by any proxy or CDN in front of the
  site, and passed on in the `Referer` header of every link followed out of the
  page — none of which the club's own log redaction can reach.

  The filter now travels as the member's id alone. Sharing or bookmarking a
  filtered view works exactly as before: opening the link looks the member up and
  shows their name on the filter chip, and an address saved before this change is
  rewritten without the name and email the first time it is opened.

  One visible difference: if an administrator's role can read the audit log but
  not the membership roll, the chip reads "Selected member" instead of a name. The
  filter still works — only the name needs membership access.
