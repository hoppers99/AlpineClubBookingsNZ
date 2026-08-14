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
  is handling, and two automatic checks hold the line: one refuses the
  hand-written spellings across the application, the operator scripts included,
  and the other reads the database's own definition of each column and refuses
  any date derived from a timestamp that has not been explicitly reviewed and
  recorded. The first reads the shape of the code rather than understanding it,
  so it is a guard and not a cage — the configuration file names, next to the
  rule, both what it catches and the few ways of writing the same thing that
  still get past it. The second is what covers the meaning.

  The second check found live problems while it was being built, in a corner no
  previous audit could reach: a single one-line shortcut in the Xero code had
  about eighteen invoice, credit-note and payment dates behind it, hidden from
  every earlier search. Seventeen of them took today's date from the world clock
  rather than the club's calendar, so a document raised in the New Zealand
  morning was dated the previous day in Xero — and across the end of a month
  that is the wrong accounting period. Two more derived a due date from a
  timestamp, the same fault #2697 fixed on a neighbouring document. **None of
  those were changed here**, because changing which day reaches the club's
  accounts is a decision for the treasurer rather than a side effect of a
  tidy-up: they were fixed under #2834, which has since shipped. The shortcut
  that hid them is now deleted, so they cannot slip out of view again. One
  member-facing "details last confirmed on" date has the same fault and is still
  open under #2839; it is the single entry left on the check's reviewed list,
  and three related "today" comparisons are filed under #2838.

  The two automatic checks the build now runs — this one and the money-rounding
  one added alongside it (#2685) — are built on one shared list rather than two
  copies, and each measures the real configuration rather than a copy of it.
  That is not tidiness. The tool that runs them replaces a rule's whole
  configuration rather than adding to it, so a change written to relax one check
  can silently switch the others off for the same files while the build stays
  green; when the two changes were first brought together, an automated merge
  lined the two up so that accepting one side would have deleted the other's
  money check outright, with nothing failing. Seven ways of making that mistake
  were tried deliberately against the finished checks — dropping a guard from a
  block, adding a block with a shortened list, writing a pattern that carves out
  a screen directory, omitting the file pattern entirely, and downgrading the
  rule from an error to a warning among them — and every one of them now fails
  the build, naming the screens it would have left unguarded.
