- **Typing in the Raw CSS box on Site Appearance is no longer slow (#2742).**
  On **Admin → Setup & Configuration → Site Appearance & Content**, the "Raw
  CSS" step had grown a noticeable lag — around two seconds behind each
  keystroke — that made editing custom CSS painful. Every character typed was
  needlessly regenerating the whole colour palette, the accessibility contrast
  checks, and both live previews, even though raw CSS feeds none of those.

  The raw CSS box now updates on its own, so typing in it stays instant, and the
  colour previews are computed once and shared instead of twice per render. The
  saved result, the generated-stylesheet preview, and the character-count
  warning are all unchanged — only the responsiveness while typing is fixed.
