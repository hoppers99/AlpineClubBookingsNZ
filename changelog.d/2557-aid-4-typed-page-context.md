- **AI Diagnostics can now be told which admin page you are on, without being
  told anything it has to take on trust (#2373).** The forthcoming admin-only
  diagnostics assistant needs to know the page and record you are looking at
  before it can explain anything about them. Rather than letting the browser
  describe the page in free text, it now sends only a short, strictly checked
  list of choices — which registered page, at most one record, and the tab or
  filters you have applied — and the server looks everything else up itself.

  Every lookup re-checks your own admin permissions from the database at that
  moment, so a permission removed a minute ago takes effect on your very next
  question, and a page that draws on two areas (bed allocation, which needs both
  Bookings and Lodge Operations) needs both, not either. If you are missing one,
  the assistant is told plainly that the detail is omitted and why, instead of
  quietly seeing less than you expected — or more.

  Personal details are off by default. What the assistant sees about a record is
  its state — is this booking confirmed, how many nights, which lodge — and
  never a person's name, unless you tick **Include this record's personal
  details** for that one record. Contact details are never included at all at
  this layer. Anything written down afterwards is counts and timings plus a
  one-way hash of the record reference: never the question, the answer, or any
  field value.

  There is nothing to turn on or configure. AI Diagnostics remains off by
  default and the assistant screen itself arrives in a later change; this is the
  page-awareness it will use when it does.
