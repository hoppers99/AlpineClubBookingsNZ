- **You can now delete a page you added, not only hide it (#2352).** Each of your
  own pages on **Admin → Setup & Configuration → Site Appearance & Content →
  Page Content** gains a **Delete** button beside **Hide**. Hide is still the
  reversible one and is still the right choice whenever a page might come back;
  Delete removes the page and its content for good, with no recycle bin and no
  Restore.

  The confirmation tells you what you are about to lose before you commit: the
  address that disappears, whether the page is live on the public site right now
  (in which case that address starts returning "page not found" straight away,
  not on a delay), any other pages of yours whose text links to it, and whether
  the header's **Book Now** button is pointing at it — in which case the button
  goes back to the booking flow rather than breaking.

  Nothing you have deleted vanishes without a trace: the full content of the page
  is written into the audit log at the moment it is removed and kept for seven
  years, so a full administrator can read a page back out and retype it. That is
  a records trail, not an undo button, which is why the dialog suggests hiding
  instead if you might want the page back.

  The pages the starter site ships — Home, About, Join, Apply, Rules, Contact,
  Committee, Privacy, Terms, FAQ and Page Not Found — cannot be deleted, exactly
  as they cannot be hidden, because the site itself links them. The slug of a page
  you delete is free to reuse at once, which is the normal repair for a mistyped
  address. Deleting a page never deletes the images it used.

  Under the covers this closes the last gap in the public-website caching work:
  every other way page content can change already clears the stored copy of the
  public site the instant it is saved, and deletion was the one lifecycle step
  with no supported way to do it at all. It now clears that copy the same way, so
  a deleted address answers "page not found" on the very next request.

  Decisions taken here, each the recommended option on the issue: deletion is
  final rather than a second hidden state; a deleted address 404s through the
  existing path rather than serving fallback content; exactly the pages that may
  be hidden may be deleted; references are reported rather than blocking; the
  gate is the same content-edit permission that already allows replacing a page's
  whole body; a slug may be reused immediately; the endpoint lives on the existing
  page-content address; the confirmation is the ordinary one-step destructive
  dialog; a configuration bundle exported before a deletion still re-plants the
  page on import (documented rather than special-cased); and deleting a page does
  not delete its images.
