- **A school group's teachers no longer block you from rostering a hut leader
  for those nights (#2926).** Approving a school booking creates one hut-leader
  record per teacher, all on the same dates at the same lodge. Those records
  used to count as a clash, so for as long as the school was in the lodge nobody
  could add another hut leader for those nights — even though the school
  approval itself was never checked against anyone else's assignment. That
  one-way rule was never a decision anybody took.

  Teacher records now sit outside the clash check. Nothing else about the rule
  moved: two ordinary assignments at one lodge still cannot overlap by more than
  the one-day handover, and approving a school booking still never refuses on
  the grounds of an existing hut leader.

  The nightly automatic assignment is unchanged on purpose. It still treats a
  night with teachers on site as already covered and leaves it alone — somebody
  responsible is there — so the difference you will notice is when you add a hut
  leader yourself.

  Each hut-leader record now remembers which part of the system created it —
  an officer, the nightly job, or a school approval — and that is what the clash
  check reads. It is recorded once when the record is created and never changes
  afterwards, so editing a member's details, type or access level can no longer
  change whether their assignment counts. Existing records are labelled during
  the upgrade: records held by the non-login member accounts a school approval
  creates are marked as school-created, and everything else is treated as
  officer-assigned. Where the upgrade cannot tell, it errs towards leaving the
  record counting as a clash, which is how the system behaved before.
