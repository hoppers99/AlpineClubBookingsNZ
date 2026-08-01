- **Three places now say what actually went wrong instead of blaming an email
  address or a promo code (#2455).** When the database refused a write because
  something was already taken, these paths assumed they knew which thing it was
  and said so, even when the real clash was somewhere else entirely.

  A member confirming a change of email address was told their new address was
  already in use whenever anything at all collided during the confirmation, so
  they would go off and pick a different address that they never needed to
  change. Now only a genuine clash on the address itself says that; anything
  else reports an ordinary failure they can retry or report.

  Importing members from a CSV reported "one or more login emails already
  exist" for any collision, sending an administrator hunting through a
  spreadsheet where every address was fine. A collision on something other than
  a login email now says plainly that one of the imported details is already
  used by another record. Either way the import is still all-or-nothing — no
  members are created.

  Creating a work party (working bee) event generates a private promo code and
  retries if that code happens to already exist. It used to retry on any clash
  at all, silently spending all five attempts on a problem that regenerating
  the code could never fix. It now retries only the code clash it exists for —
  a clash the database names as something else is reported straight away — and
  records the details when it genuinely runs out of attempts.

  Nothing an administrator does changes; the messages are simply accurate now.
