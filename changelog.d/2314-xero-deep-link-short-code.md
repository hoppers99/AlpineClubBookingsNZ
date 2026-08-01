- **"Open in Xero" links now open the club's own Xero organisation, wherever
  the link came from (#2314).** If your Xero login covers more than one
  organisation — a bookkeeper's, or a committee member who also does another
  club's books — some of these links used to drop you into whichever
  organisation Xero happened to have open last, which meant looking at the wrong
  club's records.

  The admin screens were fixed for this earlier; what is fixed now is every link
  the system builds behind the scenes. That covers the Xero Sync page's
  operations and inbound-events panels, the duplicate- and suggested-contact
  panels, the per-record Xero activity timeline, the link handed back after you
  link, push or force-sync a member, and the Xero links inside the admin alert
  emails (the cash-settlement conflict alert, the repeated-failure alert and the
  nightly reconciliation report).

  Links saved against a record deliberately stay organisation-neutral, and the
  organisation is applied when the link is shown. That way, if the club ever
  reconnects to a different Xero organisation, old links follow the new one
  instead of pointing at books the club no longer has.

  Nothing is ever hidden. If Xero is disconnected or the organisation cannot be
  read, the link still works — it simply opens Xero without naming the
  organisation, exactly as before.

  One access note: the small endpoint the deep links read the organisation code
  from is now explicitly restricted to admins with finance access, which is who
  it was already intended for. An admin without finance access still sees every
  Xero link; theirs just open Xero without naming the organisation.
