- **A member without their own email address now inherits one from a parent, and
  from nobody further away (#2716).** Until now the address could travel up the
  family tree: a child with no address could end up receiving club mail at a
  grandparent's or great-grandparent's inbox, whenever the generations in
  between had no address of their own. That is no longer the case. A member
  inherits from a parent, or from nobody.

  The reason is predictability for the person whose address it is. A grandparent
  who supplies an email so one grandchild can be contacted does not thereby
  expect to receive notifications for a branch of the family they may have
  nothing to do with. One hop can be explained to a member in a sentence.

  There is a cost, and it was accepted deliberately: where a parent has no email
  address, their child now has no way of being reached and the club has to ask
  for one. A gap you can see is better than a message going somewhere nobody
  chose — so the gap is shown rather than left to be discovered. See below.

- **Club email now follows an address when it changes, instead of pointing at
  whoever it pointed at when the link was first made (#2716).** Previously, once
  a member had been set up to receive another member's notifications, that
  arrangement was never revisited. If the parent changed their email address, or
  had it removed, the child's notifications carried on going to the old
  arrangement — which could mean an adult who was no longer the right person, for
  as long as nobody noticed.

  Adding, changing or removing a member's email address now re-checks everyone
  whose notifications depend on it, immediately and as part of the same change.
  A removed address stops being used at once; an address that comes back is
  picked up again automatically, without an administrator having to redo the
  link. No confirmation step is involved: with inheritance limited to a parent
  there is nothing for anyone to decide.

  A nightly job (6:45 am) re-checks the whole membership as a backstop, so a
  missed or interrupted update repairs itself on the next run rather than
  needing to be found by hand.

- **Two new ways to find members the club has no way to reach (#2716).** The
  members list gains a "Contactable" filter, and the Stuck States page gains an
  entry that links straight to it. Both distinguish two situations, because they
  need different actions: a member who is waiting on a parent's email address,
  and a member with no email address on record at all.

  The first is easy to miss without this, because such a member often *looks*
  contactable — the address stored against them is frequently a copy of the one
  they used to inherit, so mail to it would reach somebody else.

  **When this release is deployed**, any existing arrangement that reached past a
  parent is moved onto the parent, and where that parent has no address it stops
  and the member appears on these two screens. Expect a list on the first day.
  Recording an email address for the parent restores the arrangement on its own.
