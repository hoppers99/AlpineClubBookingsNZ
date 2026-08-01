- **Merging two duplicate member records no longer quietly discards a family
  link saved while the merge is running (#2437).** Family links — who a
  member's parent or second parent is, whose email address they share, and who
  confirmed their details — can be edited by one admin at the same moment
  another admin is merging that member. The merge used to finish anyway: the
  just-saved link still pointed at the duplicate record, the duplicate was
  deleted moments later, and the link vanished with it — no error, no warning,
  and nothing in the audit trail.

  The merge now notices that a family link changed while it was running and
  stops safely with a clear message naming what changed, before anything is
  saved. Nothing about either member is altered; the operator re-runs the
  merge preview, sees the up-to-date family links, and the retry goes through.

  The merge preview is also now honest about the one family link a merge
  deletes rather than moves: when the surviving member's own link points at
  the duplicate record, the preview says it will be cleared instead of listing
  it as history to be moved, and the audit records the clearance explicitly.
