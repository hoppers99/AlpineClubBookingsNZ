- **Upgrades that rewrite data a club has typed in are now tested against a real
  database before they can be released (#2418).** A handful of upgrades do more
  than add new fields: they go back and change wording, addresses, or settings a
  club already has — for example the recent ones that removed the Tokoroa lodge
  address and the Ruapehu affiliations that every install used to inherit.

  Until now the automated checks proved only that such an upgrade was valid
  database language. They ran it against an empty database, where an instruction
  that changes existing records has nothing to change and therefore always
  appears to work. Everything that has ever gone wrong with this kind of upgrade
  went wrong on records that actually existed — wording a club had written being
  matched by accident and destroyed, or a change reaching every club instead of
  only the ones still holding the original text.

  Every upgrade of this kind now ships with a small worked example: what a club's
  records look like beforehand, and exactly what they must look like afterwards.
  Before each release those examples are replayed on a real, throwaway database
  that has been brought up to the same state as a live install, and the upgrade
  is run for real against them. The release is blocked if the records do not come
  out as promised, and blocked again if such an upgrade is written without one of
  these worked examples at all.

  The examples are also checked for being worth having: each one is re-run
  against deliberately broken versions of its own upgrade, and if a broken
  version still passes, the release is blocked until the example is sharpened.

  Nothing about how the system runs day to day changes, and no upgrade already
  released is affected.
