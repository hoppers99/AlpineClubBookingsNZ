- **The front page no longer says the lodge "welcomes members and guests
  year-round" (#2431).** Every database built from this repository had that
  sentence written into the home page's hero — the line under the club name,
  above the fold, and the same sentence a search engine quotes under your club
  in its results. It reads as open visitor accommodation: anyone may come,
  anyone may book. The starter FAQ seeded right beside it says the opposite —
  that a non-member stays only as the invited guest of a financial member who is
  also staying — so the reference site contradicted itself, and the front page
  was the one making the wrong promise.

  **A fresh install's hero now reads:** *"Our club lodge welcomes members
  year-round. Log in to book a stay, or apply to join and explore New Zealand's
  mountains."* Two doors, both real: members log in — the same words as the
  button in the header and the answer in your FAQ — and everyone else starts at
  the Join page. Nothing else on the page moves — the eyebrow line ("Welcome to
  the Club Lodge"), the heading ("Club Lodge") and your page body are all
  unchanged.

  **If your front page still shows the old sentence, it is rewritten when you
  upgrade.** A one-off cleanup replaces the hero wherever it is still exactly the
  sentence this project put there. You do not have to do anything, but it is
  worth loading your front page after the upgrade to see the new wording — and to
  reword it in your own voice if you would rather. **Admin → Setup &
  Configuration → Site Appearance & Content → Page Content → Club Lodge**, then
  Save. Public pages are cached briefly for logged-out visitors, so allow a
  minute or check while signed in.

  **One thing to redo: export a fresh configuration bundle.** A bundle exported
  before this release still holds the old sentence, and importing one writes it
  back — so restoring an install from an older bundle would put the old wording
  on your front page again. Re-export after upgrading, replace any archived
  bundle you would restore from, and load your front page after any import.

  **A hero you have written yourself is not touched.** The cleanup matches that
  one exact sentence and nothing else, so a club that has edited its front page —
  even one that only reworded part of the line — keeps what it saved, byte for
  byte. Re-running changes nothing, and no other page or setting is affected.
