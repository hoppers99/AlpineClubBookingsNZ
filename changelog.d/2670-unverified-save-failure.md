- **Six screens no longer tell you a change "was not saved" when they have no way
  of knowing (#2668).** When a browser sends a change and the connection drops,
  it gets exactly the same silence whether the request never left your phone or
  whether the club's system received it, did the work, and only the reply went
  missing. Six controls treated that silence as proof that nothing had happened,
  and said so: the preferred-room picker on a booking said "Your room request was
  not saved", the cash-payment control said "Nothing was recorded", the
  refunds-to-pay-back-by-hand queue said "Nothing was changed", the roster editor
  said "Roster not saved", the bed-allocation removal dialog said "nothing was
  removed", and the restore-built-in-boards action said "Nothing was changed".

  On a phone at a lodge, or on patchy lodge wifi, that is an ordinary thing to
  happen, and there is no way to tell the two cases apart from the phone's side.
  It sent a member back to redo a change the club's records already held, and it
  told an officer who had just recorded a cash payment that nothing had been
  recorded — so the natural next step was to record it again. The system does
  refuse that second attempt, so the money was never recorded twice; what the
  officer was left with was the wrong idea of whether the club had been paid.

  All six now say what is actually known — "we could not verify whether X was
  saved" — and tell you where to look: reload the page, or the booking, or the
  board, and check before trying again. Where the system itself gives an answer,
  nothing has changed: "your beds have been allocated by the lodge and can no
  longer be changed here" and every other refusal still reads exactly as it did,
  because there the system is the one that knows. One refusal reads better: a
  roster save the server turned down without saying why used to be reported as
  the service being unreachable, which sent you to check your connection instead
  of your draft.

  On the two places where money is involved — recording a cash payment, and
  closing a refund to be paid back by hand — the message now stays on the
  confirmation box instead of appearing briefly and fading. The button that
  records it is switched off while the message is up, and the way out reads
  **Close and check**, because the one thing worth doing next is looking at the
  booking before pressing anything again.

  The roster editor had a sharper version of the same problem: if the save
  succeeded but the reply came back in an unexpected shape, it announced "Roster
  not saved because the service could not be reached" — contradicting the only
  side that knew. That now says it could not confirm, and your draft is still
  kept either way.

  One related fix on the admin notification-recipients page: a card whose answer
  never arrived used to snap back to its previous ticks, showing you settings the
  system may no longer hold. It now keeps your ticks with **Save** still
  available, while a card the system actually refused still goes back as before.
