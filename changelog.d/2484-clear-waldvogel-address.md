- **A new install no longer publishes another club's lodge address on its
  Contact page (#2484).** Every database built from this repository — a fresh
  install, a local staging stack, a fork taking the migrations from scratch —
  had "Waldvogel Lodge, Iwikau Village, Mt Ruapehu, New Zealand" written into
  its default lodge's address by the upgrade history, and the public Contact
  page showed it under Club Details. That is a real club's real lodge, and it
  was never anyone else's to publish. It came from a step written back when this
  codebase *was* that club's live site, where moving the address out of the page
  and into the database was the correct thing to do; the same step then ran on
  everybody.

  A one-off cleanup now blanks that address wherever it is still exactly the
  string above, so the Contact page shows no address block at all until an admin
  enters the club's own. Note that the **lodge name goes with it**: the page
  draws the pin, the lodge name and the address as one block, and only when an
  address is set, so both lines disappear together and both return as soon as an
  address is entered. Nothing else on the page changes — the contact role, its
  phone and email, the contact form and the page content are untouched.

  **If your Contact page currently shows that exact address, it will be empty
  after you upgrade.** Put your real address in under **Admin → Setup &
  Configuration → Site Appearance & Content → Club Identity → Lodge details →
  Address**, then **Save lodge details** — about a minute's work, and it appears
  on the Contact page (and in the `{{lodge-address}}` content token)
  immediately. Nothing warns you in the product, so add it to your post-upgrade
  list.

  **An address you have already entered yourself is not touched.** The cleanup
  matches that one string and nothing else, so any club that has set its own
  address — and every extra lodge a multi-lodge club has created — keeps it
  exactly as it was.
