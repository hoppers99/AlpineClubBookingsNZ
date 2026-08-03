- **AI Diagnostics can now look things up in the database — through a credential
  that is physically incapable of changing anything (#2374).** This is the
  plumbing that will let the admin-only AI Diagnostics tool answer questions about
  what the system currently says, and it is built so that the assistant can never
  write, never run a query of its own devising, and never reach the club's stored
  passwords or provider keys.

  Three things make that true rather than merely intended:

  - **The assistant cannot write its own queries.** Every lookup it can perform is
    a fixed, reviewed query that ships with the software. The assistant only
    chooses which one to run, and the values it may supply are checked against a
    strict shape first. There is no path by which it can invent, extend, or
    combine a query.
  - **A separate, deliberately powerless database login.** Diagnostics lookups do
    not use the site's normal database connection (which, in the standard setup,
    has full administrative rights). They use a dedicated login that can only
    read, only from an explicitly listed set of tables, inside read-only
    transactions that the database itself cuts off after five seconds. The
    software does not take that on trust: it asks the database what the login is
    actually allowed to do — including whether it can change anything, and whether
    it can read anything outside the listed set — and refuses to run at all unless
    the answer is "almost nothing". That answer is re-checked at least once a
    minute while the site is running, so a login widened by hand stops being
    accepted within about a minute, and the readiness page says so. It never falls
    back to the site's ordinary connection.
  - **Permissions are re-checked every single time.** Each lookup names the admin
    area that already governs that data, and the operator's current permissions
    are re-read from the database for every request. A permission removed
    mid-conversation takes effect on the very next lookup. Lookups an operator
    cannot use are also hidden from the assistant, but that is only a courtesy —
    the check that matters runs regardless.

  **This release adds no actual lookups.** The only one registered reads no club
  data at all: it reports whether the read-only connection is working and
  correctly restricted, so the plumbing can be verified before anything is
  exposed. The real lookups — bookings, membership, finance — arrive in later
  releases, each with its own permission review and its own table permission.

  Every lookup is recorded in the audit trail, kept for 24 months alongside the
  club's other admin data-access records. What is recorded is deliberately
  minimal: which lookup ran, whether it was allowed, how many rows and bytes came
  back, how long it took, and fingerprints that let two identical lookups be
  matched — never the values read, and never the question asked.

  **Operators: one new setup step.** Before AI Diagnostics can be used, the
  read-only database login must be created by running
  `npm run diagnostics:provision-role`, and the resulting connection string set as
  `AI_DIAGNOSTICS_DATABASE_URL`. Until then the AI Diagnostics readiness page
  reports the product as not ready and says which step is outstanding — it
  distinguishes "not set up yet" from "set up but has too much access". The
  module ships off, so nothing changes for a club that is not using it. The
  command is safe to re-run at any time, which is also how the password is
  rotated. Full instructions are in `docs/ai-diagnostics/deployment.md`.

  One note for forks: creating this login requires taking away the database's
  default permission to create temporary tables from *all* logins and handing it
  back to the ones that need it. The standard setup is unaffected. A fork whose
  application login is not a database superuser must list it in
  `AI_DIAGNOSTICS_DB_PRESERVE_TEMP_ROLES` before running the command — and that
  login's name must be letters, digits and underscores only, which is what the
  command can safely put into the statements it runs. A hyphenated or
  `name@server` login (common on hosted PostgreSQL) is refused with a message
  saying which setting to change, rather than a stack trace.
