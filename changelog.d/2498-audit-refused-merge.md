- **A refused member merge now leaves an audit trail (#2498).** Until now only a
  completed member merge wrote an audit record; an attempt that was refused —
  because the two members drifted mid-merge, a guard blocked it, the confirmation
  phrase was wrong, the preview had gone stale, or a member was missing — rolled
  back and left nothing behind but a server log line. Refused attempts are now
  recorded too, so an admin repeatedly trying a merge that keeps being refused is
  visible in the audit trail. Each refusal writes a single `MEMBER_MERGE_REFUSED`
  entry naming the acting admin, both members, and why it was refused; it never
  stores member details beyond what a successful merge already records, and if the
  audit itself cannot be written the merge still refuses cleanly rather than
  erroring.
