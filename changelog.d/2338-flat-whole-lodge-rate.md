- **Clubs can now charge a single flat per-night rate for a whole-lodge
  booking, chosen per approval (#2338).** Each season can now carry an optional
  flat whole-lodge night rate alongside its usual per-guest hut rates, set on
  Admin → Finance → Fees → Hut fees. Leave it blank and nothing changes:
  whole-lodge bookings still price per guest exactly as before.

  When a season has a flat rate, a booking officer approving a member's
  whole-lodge request can choose, on that one approval, whether to price it "per
  guest" (the default — nothing changes unless the officer picks otherwise) or
  "as whole lodge". Priced as whole lodge, the booking is charged the flat rate
  for each night regardless of how many people come; a stay that crosses a
  season boundary is charged each night at that night's season rate. The
  officer's own total price override still wins over both, and if a night has no
  flat rate set the approval quietly falls back to per-guest pricing rather than
  charging nothing.

  The new rate travels with a configuration backup: exporting and restoring a
  club's configuration carries each season's flat whole-lodge rate, so a restore
  no longer loses it.
