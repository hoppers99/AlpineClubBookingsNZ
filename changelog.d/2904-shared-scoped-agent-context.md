- **The coding agents that maintain this site now share one rule book and can
  look up just the part of the code they need (#2903).** Codex and Claude Code
  previously read two overlapping instruction files, so the same rules were
  written twice and drifted apart. `AGENTS.md` is now the single authority and
  the Claude file is a short adapter that imports it, which removes the
  duplication without dropping a single safety, review, validation or merge
  rule.

  A new maintainer command, `npm run agent:context`, builds a small local map of
  a chosen part of the code — the files around one entry point and the database
  models it touches — instead of an agent reading its way across the whole
  repository to find them. The map is capped, written to an ignored local
  folder, never committed, and built only from files already in version control,
  so nothing private or untracked can leak into it.

  There is nothing for an administrator to do, and no part of the booking site
  behaves differently. The benefit is that routine maintenance work now consumes
  far less of the monthly agent allowance, leaving more of it for real changes.
