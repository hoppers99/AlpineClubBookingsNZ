- **The AI Diagnostics setup check no longer says the module is switched off
  when it simply could not read the setting (#2803).** If the club's module
  settings could not be read for a moment — a brief database hiccup, or the short
  window during an upgrade where the new code expects a setting the database has
  not been given yet — the readiness check reported AI Diagnostics as *off* and
  told whoever was looking to switch it on. It may well have already been on, and
  nothing else on the screen suggested anything had gone wrong.

  It now says plainly that it could not tell. The module state reads as *unknown*
  rather than *off*, with its own reason code (`module_flags_unreadable`) that is
  kept separate from the code meaning somebody genuinely turned the module off
  (`module_off`). The diagnostics assistant is given both meanings in so many
  words, so it cannot report one as the other either.

  The check still answers, exactly as before, even when the database is
  completely unreachable — that is the moment it exists for. What it will no
  longer do is state a setting it was unable to read. An unknown module state
  still holds AI Diagnostics back from running, so nothing starts spending on a
  configuration nobody could confirm.
