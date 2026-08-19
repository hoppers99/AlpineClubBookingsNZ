- **Every automated email now uses the club's saved colours, including the first
  one after a restart (#2900).** Emails are coloured from the saved Site Style
  theme, but the colours were read into a cache in the background. A freshly
  started server could therefore build its first email before that read finished
  and send it in the platform's default teal, while the next message a minute
  later carried the club's real brand — so two emails about one action could
  arrive looking like they came from two different clubs.

  Email HTML is now always built after the saved colours have been loaded, at
  every send path rather than in the handful of templates where the problem was
  noticed. Nothing about the colours themselves changed, and there is no new
  setting to configure.

  If the saved style genuinely cannot be read at that moment — a brief database
  fault — the email is still sent, in the platform's default colours, and the
  server log carries a warning saying the style was unreadable. Previously that
  same fault silently stored the default colours as though the club had chosen
  them, so every email for the next five minutes was quietly off-brand with
  nothing said about it. The club's last known colours are now kept instead, and
  emails return to normal as soon as the style can be read again.

  A database that has stopped answering — rather than one that answers with an
  error — no longer slows the mail down either. The first message in a half-minute
  window waits briefly for the colours and the rest go out at once on the colours
  already in hand, so publishing a notice to a few hundred members cannot turn
  into an hour of waiting, and an admin answering a refund appeal is not left
  watching the page. Whichever message is the first one after the database answers
  again carries the club's colours.
