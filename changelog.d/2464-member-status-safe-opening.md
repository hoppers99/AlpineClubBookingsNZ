- **Members and Subscriptions now say clearly whether an account can sign in,
  and opening a member no longer starts an edit (#2359).** Both lists use the
  same four Access states — **No login**, **Not invited**, **Invited**, and
  **Can log in** — with neutral, warning, information, and success tones. A
  member's admin or organisation role no longer changes that label or colour.
  Xero contact-group badges also keep the same categorical colour between the
  two lists instead of changing with each row's group order. Sorting Members by
  **Access** now follows that same four-stage status instead of the hidden
  legacy role.

  The Members row action now says **Open** and is available to view-only
  membership admins as well as editors. The member's name remains a link, but
  both routes open the detail page read-only; editing still starts only after
  choosing **Edit** inside a section. Subscriptions follows the same safe route
  for viewers who also have membership access. A finance-only viewer sees the
  member name as plain text, rather than a link to a page their role cannot
  open.

  Finance-view-only users can still read Subscriptions, but the two Xero sync
  actions are now disabled with the standard view-only explanation; the POST
  route continues to require **Finance edit** access.
