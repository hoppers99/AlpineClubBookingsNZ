- **Two places that read a database "already taken" failure now read it
  correctly (#2412).** Both were guessing at the shape of the error PostgreSQL
  hands back, and both guessed wrong. This time the shape was measured — the
  duplicates were forced against a throwaway PostgreSQL 16 built from the real
  migration history — rather than reasoned about.

  **Group booking join codes.** When an organiser opens a group on their booking,
  the system invents a short join code, and if that code somehow already exists
  it is supposed to invent another and try again. It was not doing that. The
  retry looked for the collision in a field the current database driver never
  fills in, so it never recognised its own case and never retried. Nobody had
  noticed because a clash is roughly a one-in-850-billion event — the retry was
  broken, not load-bearing. It now recognises a real code clash and retries, and
  if it somehow exhausted all five attempts it says so, instead of telling the
  organiser their booking already has a group. A genuine "this booking already
  has a group" conflict is still reported straight away rather than being retried
  pointlessly.

  **Creating a member.** Any uniqueness failure while creating a member was
  reported as *A member with this email already exists*. That is usually true —
  the login-email rule is the only clash this path can normally produce — but it
  would have sent an admin off to fix an address that was perfectly fine if
  anything else ever collided. The email wording is now used only when the email
  rule actually fired; anything else gets a plain "one of their details is
  already used by another record" and is written to the server log, since on this
  path it would mean something unexpected. A member who cannot log in is never
  told their address is taken at all — the login-email rule cannot apply to them.
  The member **edit** path (#2385) now shares the same measured code for deciding
  whether the email rule fired, though it still answers a non-email clash with
  its existing "failed to update" error.

  For developers: `docs/ARCHITECTURE.md` now records exactly what the `pg` driver
  adapter populates on a uniqueness failure, including the finding that a
  hand-written partial index and a schema-level unique column are
  indistinguishable in the error — an assumption to the contrary had cost two
  separate sessions' reasoning.
