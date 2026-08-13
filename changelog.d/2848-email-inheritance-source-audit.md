- **Automatic email-inheritance re-resolution now leaves an audit trail, so
  "when did this member's contact of record move, from whom to whom, and why?"
  is answerable (#2822).** A member with no address of their own can inherit one
  from a direct parent, and that routing re-resolves on its own when addresses,
  family links or lifecycle state change. Until now those automatic moves left no
  per-member record, so a routing change discovered months later could not be
  explained.

  Every time the re-resolution actually moves a member's effective email source,
  the club now records one `member.email-inheritance-source.changed` entry in the
  **Family** category. It stores the previous and new source member ids and what
  triggered the change — a member's own edit, a family link change, a lifecycle
  or age-tier move, a nomination promotion, a merge, or the nightly sweep — and
  it never stores an email address. A change the nightly sweep or a scheduled job
  found is recorded as **System**, not as a person who did not make it, and a
  reconciliation that changes nothing writes nothing.

  The entry is written inside the same transaction as the routing change, so it
  cannot survive a change that was rolled back. It carries **standard** retention,
  and — because Family is a member-visible category — the subject member may see
  the generic event on their own timeline, but never the source member ids, the
  metadata, or any admin drill-down, which stay on the admin audit screen.
