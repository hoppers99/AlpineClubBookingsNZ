- **A pure-grey brand colour now produces a genuinely grey site palette (#2303).**
  The colour library that builds every club's 12-step palette from its three
  brand seeds has been updated. For almost every club nothing changes at all —
  the palette that comes out is identical, colour for colour, to the one the
  site is showing today.

  The exception is a club whose **neutral-character** seed is an exact grey
  (its red, green and blue values are all the same — `#000000`, `#767676`,
  `#8f8f8f`, `#ffffff` and so on). Those palettes used to pick up a faint pink
  cast in light mode: page and card surfaces came out as `#fef4f7` / `#f1e6ea`
  rather than a plain grey. That tint was never chosen by anyone — it came from
  a rounding artefact deep in the old colour library — and it is gone. The same
  seeds now derive a clean grey ramp (`#f7f7f7` / `#e9e9e9`), and the accent
  steps that are levelled against that ramp move by at most one shade. Dark
  mode is unchanged in every case.

  If your club uses a grey neutral-character seed and you preferred the warmer
  look, pick a seed that actually carries the tint you want — the site-style
  wizard preview shows exactly what will ship before you save.
