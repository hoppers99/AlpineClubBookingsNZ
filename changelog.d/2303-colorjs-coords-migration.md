- **The colour library behind every club palette has been updated (#2303).**
  The library that turns a club's three brand seeds into its 12-step site
  palette moved from colorjs.io 0.5.2 to 0.7.1. The upgrade is deliberately a
  no-op for how your site looks: the shipping default palette comes out
  byte-for-byte identical, colour for colour, in both light and dark mode, and
  so does every palette built from a brand colour with any real saturation to
  it.

  Only one narrow group of palettes moves at all, and only very slightly. If a
  club's **brand colour is very close to grey** — so desaturated that the
  palette builder's nearest reference ramp is a pure grey one — a handful of its
  12 steps can shift by a couple of shades, too little to read as a colour
  change on screen. Across a sweep of 40,560 palette steps built from 130 seed
  combinations, 1.5% of steps moved at all, and the largest single move was 8
  values out of 255 in one channel. This applies in **both light and dark mode**,
  and to a near-grey **accent or support** colour as well as to a near-grey
  **neutral-character** colour.

  These palettes keep their tint and their hue: a dusty-rose or slate-teal brand
  colour still produces a dusty-rose or slate-teal palette, exactly as before,
  and a neutral-character seed that is an exact grey keeps the same faint warm
  cast the site has always given it. The reason the numbers cannot be matched to
  the last digit is that the old library derived them from floating-point
  rounding noise, so there is no exact value left to reproduce — the new code
  uses the value that noise was converging on.

  Nothing needs doing. If you want to check your own palette before it ships,
  the site-style wizard preview shows exactly what will be saved.
