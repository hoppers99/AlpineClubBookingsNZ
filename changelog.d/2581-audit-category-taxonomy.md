- **The audit trail's categories are now one reviewed list instead of six
  hand-kept copies, and two kinds of activity are visible to the right people for
  the first time (#2581).** Every audit entry can carry a category, and that
  category is not decoration: it is the only thing the AI Diagnostics assistant
  can filter on, so it decides which permission somebody needs before the
  assistant will show them an event. The list of categories was written out by
  hand in six different places, and they had drifted apart.

  **Family activity was the cost of that drift.** Family groups, partner links,
  login-holder changes and dependents were recorded under a category called
  `family` that had never been added to the assistant's list — so 27 places in the
  platform were recording family history that **none** of the assistant's tools
  could return, to anybody, at any permission level. Family history is now
  readable by someone holding Support plus Membership access, which is where it
  always should have sat.

  **Communication activity moved the other way, on purpose.** Bulk email, member
  notices and delivery suppressions were readable through the assistant with
  Support access alone. Those entries carry the recipients' email addresses, so
  they now need Membership access as well. This is a real removal of something a
  Support-only operator could do yesterday, and it is deliberate: reading who the
  club emailed is membership information.

  **Three sets of entries were recorded under category names that did not exist**
  — `membership` on three membership-application events, and `auth` on sign-in
  bounce diagnostics. Nothing anywhere could filter for either, so those entries
  were invisible to every category-based reader. Membership applications are now
  `account` (Support plus Membership) and sign-in bounces are now `security`
  (Support). Separately, a member photo change used to be filed under a *different
  category depending on who did it* — `admin` when an administrator did it for the
  member, `account` when the member did it themselves. It is now `account` either
  way, because the record affected is the member's own profile regardless of who
  touched it.

  **Four of those corrections also change what a member sees in their own
  activity timeline**, because that timeline filters on category as well. A member
  now sees their own sign-in bounce entries, the membership-application entries
  that concern them, and an administrator's change to their photo made on their
  behalf. Each of those entries is about the member reading it, and a member's
  view has never shown the stored metadata, the request ID or the IP address — so
  nothing new is disclosed about anybody else.
  Members already saw their own high-volume entries of this kind under Privacy.

  **Nothing changed about Admin → Audit Log.** It still shows every entry,
  including uncategorised ones, to anyone with Support access. The categories above
  govern only the AI Diagnostics tools, which are deliberately narrower. The
  operator guide (`docs/guides/audit-log.md`) now explains what each category
  means, who can correlate it, and why two of the mismatches — induction filed
  under `lodge`, issue reports filed under `privacy` — are left alone on purpose.

  **The known gap is now measured rather than estimated.** 82 of the platform's
  418 recording points still set no category at all, which means the assistant
  returns none of them; the figure used to be quoted from a hand count that had
  gone stale. An automated check counts them on every build and **fails with the
  offending code named if a new one appears**, so the gap can only shrink from
  here. Giving each of those 82 a category is the next change, and filling in the
  historical entries the one after that. Until then, an empty AI Diagnostics result
  means "no *categorised* entry matched" — never "it did not happen" — and the
  assistant is told to say exactly that and to point operators at Admin → Audit
  Log.

  **For the owner — the eight decisions taken, each the recommended default, with
  the alternative that was not taken** (each is a one-line change to reverse):

  1. The invented `membership` (3 sites) becomes `account`; `auth` (1 site) becomes
     `security`. *Alternative:* add either as a twelfth/thirteenth canonical
     category. Cost of the default: sign-in bounce diagnostics are high-volume and
     now compete for the Support-only correlation tool's 22-row ceiling.
  2. The member-photo writers use `account` unconditionally. *Alternative:* keep
     the actor-based `admin`/`account` conditional. Cost: an administrator's
     on-behalf photo change is no longer readable with Support access alone.
  3. `member.password-reset-sent` and `member.setup-invite-sent` are recorded for
     the sweep as `security`. *Alternative:* `communication`, treating them as
     mailings. Cost: `security` is the wider gate (Support alone).
  4. Seasons and booking periods are recorded for the sweep as `booking`, fee
     configuration as `payment`, promotional codes as `booking`. *Alternative:*
     `payment` for promotional codes. Cost: a promotional code carries a discount
     amount, so price-affecting evidence sits behind Bookings rather than Finance.
  5. `issue.reported` stays `privacy`. *Alternative:* re-map to `admin` to match
     the Support screen it appears on — which would widen it to Support-only, so it
     was refused. Cost: a Support-only operator cannot correlate an issue report in
     the assistant and must use Admin → Audit Log.
  6. The single `member.bulk-…` writer is recorded as a split family — `security`
     for role changes, `account` for activate/deactivate. *Alternative:* one
     category for the whole site. Cost: the sweep must handle one dynamic action
     family rather than one static row.
  7. `communication` moves from Support-only to Support plus Membership.
     *Alternative:* leave it Support-only. Cost: the capability removal described
     above.
  8. The taxonomy, permission map and census ship now rather than waiting on the
     booking/deletion rework. *Alternative:* hold everything until that lands.
     Cost: the census manifest is reviewed once here and regenerated once more in
     the sweep.
