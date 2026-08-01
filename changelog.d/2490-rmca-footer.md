- **A new install no longer lists another region's mountain-club association in
  its footer (#2490).** Every database built from this repository — a fresh
  install, a local staging stack, a fork taking the migrations from scratch —
  had an **Affiliations** column written into its public footer listing
  "Federated Mountain Clubs (FMC)" and "Ruapehu Mountain Clubs Association
  (RMCA)", and because the footer is on every public page, so was that claim.
  Those are real bodies, and belonging to them is a fact about a particular
  club. It came from a step written back when this codebase *was* the Tokoroa
  Alpine Club's live site, where moving the footer out of the page's source and
  into the database was the correct thing to do; the same step then ran on
  everybody.

  **A fresh install now lists no affiliations at all** — the club adds its own
  when it has them. A footer column with nothing in it is hidden entirely, so
  the footer simply shows two columns instead of three: there is no empty
  "Affiliations" heading and no blank space where the column used to be.

  **If your footer currently shows that exact list, it will be empty after you
  upgrade.** A one-off cleanup blanks the affiliations column wherever it is
  still exactly the original starter list. Add your own under **Admin → Setup &
  Configuration → Site Appearance & Content → Site Content → Footer:
  affiliations**, then **Save Footer: affiliations** — a few minutes' work, and
  it appears on the public footer immediately (allow a minute for the cached
  logged-out view, or check while signed in). Nothing warns you in the product,
  so add it to your post-upgrade list.

  **Affiliations you have edited yourself are not touched.** The cleanup matches
  that one exact list and nothing else, so a club that has written its own
  links — or that simply deleted the RMCA line and kept the rest — keeps what it
  saved, byte for byte. The other two footer columns, the club blurb and the
  quick links, are unchanged.
