- **Clearer, kinder handling of what one adult can do for another in a family
  group (#2284).** Every adult with a login in a family group has always been
  able to act for the members who cannot speak for themselves — book them, edit
  their details, request their membership be cancelled. That model is deliberate
  for a club of small, trusting families, and it stays; this change records it as
  a decision and adds four protections for the non-login members it affects.

  - **Members are now told when a family member adds them to a booking.** If you
    have your own login the heads-up comes to you; if you do not (a child, or an
    adult on a household login) the adults in your family group are told on your
    behalf. It is a courtesy notice, not a request — nothing waits on a reply —
    and it is the missing half of being able to take yourself off a booking
    someone else put you on: you can only do that if you know you are on it. It
    is sent whether or not the club uses the member-guest feature, and every
    member can switch it off under **Notification preferences** in their profile.

  - **A membership-cancellation request now flags a member who could not
    confirm it themselves.** When someone asks to cancel the membership of a
    family member who has no login, the reviewing administrator sees an explicit
    "included without their own or a second adult's confirmation" note on that
    person's row, so an on-their-behalf confirmation is never mistaken for one
    the member personally gave. The request still only takes effect on admin
    approval.

  - **A delegated edit to a member's details is now visible to the family.**
    Where an adult completes or confirms another member's details, the family
    page shows a read-only "Details last confirmed by ⟨name⟩ on ⟨date⟩" line, so
    a change made on someone's behalf is no longer only in the audit log.

  - **Tidied up an unused "group admin" role that quietly controlled one thing.**
    A little-known one-step way to declare a partner for a non-login adult used
    to depend on an internal family-group "admin" marker that was assigned more
    or less at random depending on how the group was created. It now depends on
    who actually confirmed that member's details, which is a real relationship
    rather than an accident. Relatedly, asking to join a member's family group no
    longer quietly sets them up as the group's "admin" before they have agreed to
    anything.
