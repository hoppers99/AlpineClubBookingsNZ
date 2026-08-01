- **Requests for pictures and files that do not exist are answered properly,
  instead of being handed a broken copy of the club's "page not found" screen
  (#2404).** When something asks the site for a picture that is not there — an
  old link, a search engine following a stale address, or one of the automated
  scanners that probe every website continuously — the site used to reply with
  its whole "page not found" page: about 29KB of the club's branding, fonts and
  menus, sent to something that only wanted a picture. Worse, that particular
  copy of the page arrived without the security instructions every other page
  carries, so a browser receiving it would refuse to run any of it. It was a
  broken page nobody could see was broken, because nobody looks at what a
  scanner gets back.

  These addresses now answer "not found" and nothing else — no page, no
  branding, no wasted work. Two consequences are worth knowing. Addresses people
  actually type are untouched: mistyping the address of a real page still shows
  the club's own "page not found" screen, exactly as before. And the site now
  does less work per stray request, because it no longer builds and throws away
  a full page for a robot.

  The protection is deliberately doubled up rather than left to one mechanism.
  As well as not building a page for these requests, the site now applies its
  usual security instructions to them too. It used to skip that work for anything
  that looked like a picture, on the assumption that pictures do not need it —
  and measuring the assumption showed it was not saving anything: the check is
  fractionally faster than it was, the genuinely heavy traffic (the site's own
  program files) is still skipped, and the club's own logos and photographs are
  now served with the same protective headers every page carries. Two of those
  exceptions turned out to be for files the site has never had — leftovers naming
  a logo and an icon that do not exist — so they were removed rather than kept as
  two addresses nobody was protecting.

  A second, quieter fault was found while measuring this and is fixed with it. A
  few ordinary addresses were being mistaken for the site's internal machinery
  because they merely began with the same letters, and they were being served
  without those same security instructions. They are ordinary pages again. This
  is the same kind of fault that was fixed for a different set of addresses in
  the previous release note about the setup screen.

  A third fault, found the same way, mattered more and is fixed here too.
  Browsers can tell a site "I am only fetching this ahead of time, in case the
  visitor clicks" — and the site skipped its usual security work for those
  requests, which is a reasonable saving when the request really is that. But it
  took the claim at face value, and anything can make that claim about any
  address. So a request that simply said "this is a look-ahead" was handed pages
  without their security instructions, and could also slip past the "site setup
  in progress" screen on a club that has not launched yet. Trying to tell real
  look-aheads from claimed ones turned out to be unreliable — a second marker a
  genuine browser sends can be copied or altered just as easily as the first — so
  the exception was removed altogether. Every request now gets the same security
  work, including genuine look-aheads. It was measured first: skipping that work
  saved nothing worth having. **Operators should expect one visible change:** on
  a club that has not finished setup, these requests now correctly get the "site
  setup in progress" screen where they previously got a page.

  Nothing about how the site looks, how members use it, or how anything is
  stored has changed. Pictures uploaded through **Admin → Content → Images**
  are served exactly as before — that is checked automatically now, on a real
  uploaded file, because an earlier draft of this fix would have hidden them.
  The rule that catches these stray requests now leaves the site's data
  addresses alone entirely, rather than claiming them and handing them back: two
  earlier drafts each left a small trace in the reply that told a prober which
  optional features a club had switched on. Not claiming them at all leaves no
  trace to find.

  Two related tidy-ups landed with it.

  Signing in again is now the first thing an admin is told to try when a
  feature's screen will not load. Addresses belonging to an optional feature
  used to answer differently depending on whether the feature was switched off
  or the person asking was not signed in — enough of a difference that anyone
  could list a club's optional features from outside, without an account. Both
  now answer the same way. The cost is that a handful of admin screens can no
  longer say for certain which of the two happened, so they now say both: sign
  in again, and if the screen still will not load, check the feature switch
  under **Admin → Setup → Modules**. Nothing an admin can actually do changes,
  and a signed-in admin who simply lacks a permission is still told so plainly.

  The home page is still remembered by a returning visitor's own browser for a
  minute, but is no longer offered to shared caches. That option was there for a
  future content-delivery network, and there is no such network in front of the
  site today, so it was earning nothing — while relying on a safeguard that,
  on inspection, could never actually run. It will come back properly with the
  planned work on faster public pages.
