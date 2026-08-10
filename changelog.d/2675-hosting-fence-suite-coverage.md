- **Internal: eight test suites now genuinely exercise the adult-member hosting
  participant fence (#2675).** No behaviour change and nothing to do. Recorded
  because it corrects a coverage gap that only a probe could see.

  When the hosting rule gained a check that skips its work for clubs with the
  rule switched off, eight suites covering guest add, guest removal, waitlist
  confirmation, date and batch modification, consent authority and partial-stay
  pricing quietly started taking that shortcut, because their test data said the
  rule was off. They still passed — they simply stopped reaching the code they
  were there to protect, while the scaffolding beside them still looked like
  coverage. That is worse than having no test, because it reads as one.

  Their booking fixtures now describe a party the hosting rule can actually be
  evaluated against, and the list of suites known to skip the fence has shrunk
  accordingly. Three further suites remain on that list for a stated technical
  reason and are recorded there rather than left implicit; measurement confirms
  they lose no coverage.
