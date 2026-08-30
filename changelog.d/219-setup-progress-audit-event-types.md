- **Marking a setup check done, skipping it or reopening it now each show up as
  their own event in the Audit Log (#219).** Every one of those used to be
  recorded as the single event type "setup_progress.update", so filtering the
  Audit Log by **Event Type** could tell you that setup progress had changed but
  never which way — "who deferred a check, and when" was not a question the log
  could answer.

  Each action now records under its own event type, with a plain-English summary
  naming the check, and the entry points at the setup progress record so it can
  be drilled into like any other. Nothing about who may read these entries
  changes: they stay in the **system** category, the same as before, so the same
  people see them in the Audit Log and in AI Diagnostics.

  One thing to know if you filter by Event Type over a long period: entries
  recorded before this release keep the old "setup_progress.update" name, so a
  search covering both sides of the upgrade needs the old name as well as the
  new ones. The **Category** filter (system) and the free-text search still
  return the whole run either way.
