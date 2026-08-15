- **The privacy rule for what AI Diagnostics sends from the screen you are on is
  now a permanent, enforced invariant (#2379).** When an administrator asks AI
  Diagnostics a question, the filters and the typed search on the page they are
  looking at travel with the question to the AI model provider on every question,
  and neither of the two consent tick boxes changes that — those govern reading a
  record's personal details and searching for people, not the filter state of the
  screen. That behaviour shipped earlier (#2816); this change pins it as
  `INV-PRIV-014` in the invariant catalogue and adds a guard test that fails if a
  typed search ever stops reaching the provider, or if either tick starts gating
  it. Nothing an operator sees changes.
