- **Membership, finance and content admins can use the pages they hold again,
  and none of them can read a lodge's door code (#2925).** Anything that has to
  say *which* lodge it is talking about — Promo Codes, Seasons, Hut Fees,
  Lockers — first asks the system for the club's list of lodge names. That list
  used to need Lodge Operations access, which the shipped Membership Officer,
  Treasurer and Content Editor roles do not have, so those admins saw a notice
  where the editor should have been and no amount of retrying could fix it.

  The lodge list now answers any signed-in administrator, and it answers them
  with less: a role without Lodge Operations access gets each lodge's name and
  whether it is active, and nothing else. The door code, street address and
  travel notes stay with the roles that could already read them. That is the
  point of the change rather than a detail of it — opening the list up without
  trimming what it returns would have handed a physical door code to roles that
  were never meant to have it.

  Nobody gained the ability to CHANGE a lodge: creating, renaming and editing a
  lodge still needs Lodge Operations edit access, exactly as before. The Club
  Identity page's lodge card now explains that it needs lodge access instead of
  showing an empty form, and saving a lodge can no longer blank out a door code
  the admin was not shown.

  Nothing to configure. Existing role definitions are untouched — no club
  inherits wider Lodge Operations access on upgrade.
