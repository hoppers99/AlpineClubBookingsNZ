- **AI Diagnostics error reports can no longer carry a member or guest name to
  our error-monitoring service (#2379).** When a diagnostics tool failed while
  projecting, extending its consent ledger, writing its audit row, or in any
  unexpected way, the raw error was forwarded to Sentry — and a database or
  first-party error message can quote the row value it choked on, including a
  person's name. Those failure paths now forward a fixed message carrying only the
  error's type, so the reason stays diagnosable without the value ever leaving the
  server. This tightens an internal safeguard; nothing an operator does changes.
