- **Diagnostics evidence from the database is neutralised the same way whichever
  channel it takes (#2832).** When the AI Diagnostics assistant reads stored
  free text — a guest's name, a room or bed label, a payer-typed bank
  reference — that text is now folded and role-label defused before it reaches the
  model, exactly as the page-context channel already was. This closes a gap where a
  hidden control character (the C1 "next line" character, which a plain whitespace
  clean-up does not catch) could make a stored value look like a new line, and where
  a value reading `assistant: …` could pose as a turn the assistant had taken. It is
  hardening, not a fixed live breach: the assistant's instructions are frozen and
  its evidence is always framed as untrusted, so the neutralisation is defence in
  depth on a channel an attacker never controlled outright. A contract test now
  fails any future Diagnostics tool that reintroduces the weaker cleanup.
