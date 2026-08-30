- **The setup wizard now holds the real editor for a step, instead of only
  pointing at it (#238).** Two steps get it first: **Club Configuration** and
  **Club Time Zone** show their own settings form in the wizard, beneath the
  step's check, saving to exactly the same place the settings page saves to.
  Nothing is stored twice, editing is still staged — you change the fields and
  then press the section's own Save — and the link through to the full settings
  page stays, because that page usually carries more than the one section.

  Two things deliberately do not change. Saving the form does not tick the step
  off: **Mark this step done** is still the one action that records that a
  person agreed, which is what the green badge and the percentage mean. And the
  two permissions on the screen stay separate — recording progress needs
  Support edit, while the editor is governed by its own area — so an officer who
  can do one and not the other sees exactly that, with the reason stated above
  whichever half is unavailable. Club Time Zone is a full-administrator setting
  and says so in place of the form for anybody else.

  The step's check re-reads itself as soon as a save succeeds, so what the
  wizard reports catches up with what you just changed without a reload. Every
  other step looks and behaves exactly as it did.
