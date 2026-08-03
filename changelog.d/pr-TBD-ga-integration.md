- **Google Analytics is now set up inside the app, and an administrator chooses
  whether visitors are asked first (#2573). Analytics stops working at this
  upgrade until someone re-enters the measurement id — please read this one.**

  Google Analytics used to be configured by whoever ran the deployment, in a
  server setting called `NEXT_PUBLIC_GA_MEASUREMENT_ID`. It is now club
  configuration like everything else: **Admin → Setup & Configuration →
  Integrations → Google Analytics**, on the same page as Xero, Stripe and
  Backups. The card shows at a glance whether the club is set up, and opens the
  settings in place.

  **What you have to do after this upgrade.** The old server setting is no longer
  read at all, and its value is deliberately **not** copied into the new screen —
  so if your club uses Google Analytics, it stops collecting anything the moment
  this release goes live and stays stopped until an administrator with finance
  edit access enters the GA4 measurement id (it looks like `G-ABCDE12345`) on that
  card and saves. Nothing needs restarting; the change is live as soon as you
  save. Once it is working, the server setting can be deleted — it does nothing.
  We did it this way on purpose rather than carrying the old value across, so that
  nobody's website quietly starts tracking under a configuration no one had
  reviewed.

  **You now choose how visitors are asked.** There are two options and the screen
  recommends the first:

  - **Show the consent banner.** This is how it has always worked and it is still
    the default. Nothing whatsoever goes to Google — no script, no request, not
    even a "this visitor said no" signal — until a visitor selects Accept.
    Declining, or simply closing the banner, leaves analytics switched off.
  - **Do not show the consent banner.** Google Analytics loads by itself on public
    pages without asking. If you choose this, the screen warns you before you save
    it, and it explains that visitors who had previously declined will start being
    measured again.

  You can also edit the wording of the banner message. It is plain text — HTML and
  formatting are shown literally rather than interpreted — and the Accept and
  Decline button labels stay as they are.

  **Visitors can change their mind either way.** An **Analytics preferences** link
  now appears in the website footer whenever analytics is set up, in both modes.
  It shows the visitor's current choice and lets them switch analytics on or off.
  Turning it off stops further collection from that browser straight away; it
  does not, and the panel does not pretend it does, remove anything already sent
  to Google.

  **Changing the wording no longer resets anybody's choice.** If you want every
  visitor asked again — after a change of policy, say — there is a separate **Ask
  visitors to choose again** action on the same screen, with a confirmation step.
  It is recorded in the audit log with who did it and when. Fixing a typo in the
  message does nothing of the kind.

  **Where analytics runs is fixed by the application and is not a setting.** It
  runs on the public website only. It never runs on admin pages, on signed-in
  member pages, or on any page whose address carries a one-time link, a PIN or
  someone's details — and the addresses it does report are sent without the extra
  information that can follow a `?` or a `#` in a web address. Advertising
  categories stay switched off in both modes. If the club is not set up, is set up
  wrongly, or the database cannot be read, analytics simply does not run and the
  website carries on as normal.

  One thing this release deliberately does not do: it does not tell you whether
  your chosen setting meets your legal obligations. Whichever mode you pick, your
  privacy policy should say the club uses Google Analytics — the setup screen
  warns you if no privacy policy page is published and links you to it — and
  privacy requirements can depend on where your visitors are. That assessment
  stays with the club.
