- **The setup wizard no longer counts an installed default as something you
  agreed to (#237).** Installing the site fills a number of settings in for you —
  a timezone, age tiers, a cancellation policy, a bed count — and those settings
  satisfy their own setup checks. The wizard used to read that as progress, so a
  club that had made no decisions at all opened the wizard more than halfway
  through a journey nobody had walked, resuming several steps in, with the club
  still carrying the placeholder name the installer gave it.

  A step whose check passes with nobody having confirmed it now shows as
  **Default in place**. The wizard walks you to it, states what the default is,
  and asks you to look. **Marking the step done is how you confirm it** — that is
  the record that a person checked this — and if you would rather decide later,
  **Skip for now** takes you past it and leaves it on the outstanding list, as it
  always did.

  **The progress percentage now counts the steps you have confirmed.** A
  brand-new club starts at 0%, which is the honest number for a club that has
  decided nothing yet. **If you have used the wizard already, your percentage
  will drop the first time you open it after this release.** Nothing you did has
  been lost and no step has been reset: the steps you genuinely marked done are
  still done, and the fall is the steps that were only ever counting an installed
  default. There is no way to tell those two apart in what was recorded before
  now, so nothing has been guessed at on your behalf.

  **The Progress tile on Admin → Setup shows that same number.** It used to work
  out its own, counting a passing check as progress, so the checklist claimed a
  brand-new club was more than halfway through while the wizard one click away
  correctly said 0%. The tile now displays the wizard's figure. The readiness
  cards beneath it are unchanged and are not in disagreement with it: a card
  answers "is this part of the installation configured", which a setting the
  installer filled in genuinely is, while the percentage answers "how far through
  this has somebody been".

  **A default does not let you walk past it.** The wizard stops at a defaulted
  step exactly as it stops at one nothing has happened on, so **Ready to open**
  now waits until every step has been confirmed or skipped. That is deliberate: a
  club should not arrive at "ready to open" without a person having looked at
  each decision, even where the installed default turns out to be the right one.
  Skipping still counts as settled, so a club that genuinely does not need a step
  is one click past it.

  A defaulted step can never also be **Needs another look**. That state means
  work you finished has been put back in question, and nobody finished this one.

- **A fresh install no longer records a placeholder club name as though somebody
  had chosen it (#237).** The installer used to write the example configuration's
  club name into the database whenever no real `config/club.json` was committed —
  which the application's own start-up repair explicitly refuses to do, for the
  reason that a placeholder written that way becomes the club's authoritative
  name and can then only be corrected by hand.

  The installer now applies the same rule: it writes the club's identity when
  there is a real committed configuration to write, and otherwise leaves it
  alone, so **Admin → Setup** reports the club name as still to be set rather
  than reporting a name nobody chose as configured. Existing installations are
  untouched — nothing is deleted or overwritten, and a club that has already set
  its name keeps it. Set or change it any time at **Admin → Appearance → Club
  Identity**.
