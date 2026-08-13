- **AI Diagnostics now stays read-only because the database refuses it, not
  because the code remembers to (#2786).** Most diagnostic answers come from a
  dedicated read-only database login that is incapable of changing anything. A
  handful of them — booking blockers, capacity by night, member eligibility,
  booking finance, and the system-health readouts — are different: they run the
  club's own calculations, on the application's own database connection, which
  *can* write. Nothing was wrong with them, but the only thing keeping them
  read-only was that they were written that way.

  They now all run inside one shared read-only transaction. If a future change
  ever made one of them try to write, PostgreSQL itself refuses it and the
  operator is told the evidence is unavailable — instead of the change going
  through. The same transaction also puts a database-enforced time limit on each
  read, so a slow diagnostic stops costing the server work nobody is waiting for,
  and it takes all its figures from a single instant, so a booking's party size
  and the lodge's occupancy can no longer be measured a moment apart and disagree.

  **A few reads genuinely cannot sit inside it, and they are now written down.**
  The readiness check has to keep answering when the database is exactly what is
  broken; the deployment readout touches no database at all; two calculations are
  shared with admin screens and enforce limits of their own. Those five are a
  closed list with a reviewed reason each, and a new diagnostic cannot be written
  at all without stating which of them it relies on — a wrong answer stops the
  feature starting rather than passing quietly. Writing that check is what found
  the fifth one, which nobody had noticed.

  Nothing changes on screen, no diagnostic answers differently, and nothing about
  what diagnostics may look at has widened.
