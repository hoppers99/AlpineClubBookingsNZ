- **Every calendar date in the system is now produced in one place, and the
  build refuses a hand-written copy (#2684).** A lodge night, a stay date, a
  finance window edge and a date on a Xero invoice are all written the same way
  — `2026-07-01` — and the code had 119 separate hand-written copies of the
  small piece of arithmetic that produces one, in five slightly different
  spellings. Nothing an operator can see changes here: every date shows the same
  day it showed before.

  It matters because that arithmetic is only correct for some values. A lodge
  night is a plain calendar day and reads back correctly. A *timestamp* — the
  moment a booking was made, the moment a payment was taken — does not: New
  Zealand runs twelve to thirteen hours ahead of the world clock the shortcut
  reads, so for roughly the first half of every New Zealand day it names
  yesterday. That is what put a Xero invoice due date one day early (#2697). The
  two cases look identical on the page, so with 119 copies nobody could check
  them. Routed through named helpers, each one now says which kind of value it
  is handling, and two automatic checks hold the line: one refuses any new
  hand-written copy anywhere in the application, and the other reads the
  database's own definition of each column and refuses any date derived from a
  timestamp that has not been explicitly reviewed and recorded.

  The second check found live problems while it was being built, in a corner no
  previous audit could reach: a single one-line shortcut in the Xero code had
  about eighteen invoice, credit-note and payment dates behind it, hidden from
  every earlier search. Seventeen of them take today's date from the world clock
  rather than the club's calendar, so a document raised in the New Zealand
  morning is dated the previous day in Xero — and across the end of a month that
  is the wrong accounting period. Two more derive a due date from a timestamp,
  the same fault #2697 fixed on a neighbouring document, and one member-facing
  "details last confirmed on" date has it too. **None of those are changed
  here**, because changing which day reaches the club's accounts is a decision
  for the treasurer rather than a side effect of a tidy-up; they are recorded,
  reported, and fixed under their own change — the Xero document dates under
  #2834, the "details last confirmed on" line under #2839, and three related
  "today" comparisons under #2838. The shortcut that hid them is gone, so they
  cannot slip out of view again.

  The two automatic checks the build now runs — this one and the money-rounding
  one added alongside it (#2685) — are built on one shared list rather than two
  copies. That is not tidiness. The tool that runs them replaces a rule's whole
  configuration rather than adding to it, so a change written to relax one check
  silently switches the others off for the same files while the build stays
  green; when the two changes were first brought together, an automated merge
  lined the two up so that accepting one side would have deleted the other's
  money check outright, with nothing failing. One shared list, and each check
  measuring itself against it, is what makes that impossible now.
