- **Hut leaders are now auto-assigned per lodge, so a second lodge is no longer
  left without one (#2915).** The nightly job that picks a hut leader when only
  one adult member is staying looked at the whole club at once instead of one
  lodge at a time. A club with more than one lodge could be left short in two
  ways, both of them silent: once one lodge had a leader for a night, no other
  lodge would be given one; and if two lodges each had exactly one adult member
  staying, the job counted two people in total, decided that was not "exactly
  one", and assigned nobody at either.

  The job now considers each active lodge separately — who is staying there,
  whether that lodge already has a leader for the night, and whether an existing
  assignment clashes. Archived lodges are skipped. Clubs with a single lodge are
  unaffected, and nothing already assigned changes.
