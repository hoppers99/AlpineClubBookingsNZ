- **A member who asked to be deleted can no longer be given their login back by
  the ordinary Reactivate action (#2620).** When the club approved a member's
  request to delete their account, the record was anonymised — the name, email,
  phone and address were replaced — but the account itself stayed capable of
  signing in, held together only by being switched off. Switching a member back
  on is exactly what the **Reactivate** button does. Because a deleted record
  looked like any other switched-off member in the **Inactive** list, an officer
  reversing a mistaken bulk deactivate could hand a deleted person a working
  login again, with whatever administrator access they used to hold, without
  anyone intending it.

  Reactivate now refuses a deleted member outright, from both the bulk action and
  the member edit screen, with a message saying so. Deleted members are also
  shown in the members list with their own red **Deleted** status, distinct from
  Inactive, and their tick box cannot be selected at all, so they can no longer
  be swept up in a multi-select by accident.

  Sign-in is protected separately, so this cannot come back by another route.
  Password sign-in, the emailed sign-in link, and Google sign-in each refuse a
  deleted account on their own, and any session a deleted account still holds is
  ended on its next use. That holds even if the account were switched back on
  directly in the database. Google sign-in mattered most here: it recognises the
  person by their Google account rather than their email address, so replacing
  the email address alone never stopped it.

  Nothing changes for an ordinary deactivated member: they reactivate exactly as
  before. Clearing the leftover credentials from the record itself — the Google
  link, the verified-email flag and the second factor — is being done separately.
