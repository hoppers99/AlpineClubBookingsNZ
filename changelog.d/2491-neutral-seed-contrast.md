- **A club that chooses a plain-grey neutral colour now gets cards that stand
  out from the page as clearly as every other palette (#2491).** When a club's
  neutral-character colour was an exact grey, the generated light theme placed
  cards and the page background a hair closer together than the signed-off
  accessibility floor allows, and it added a faint pink tint the club never
  asked for.

  Both come from the same cause: a plain grey has no hue, so the tint the
  theme normally applies had nowhere to point and defaulted to red. A hueless
  neutral colour now produces an honestly grey theme, and its card-versus-page
  separation meets the accessibility floor by construction.

  Only fully-grey neutral colours are affected. Every club whose neutral
  colour has any real hue — including the shipping default — is completely
  unchanged.
