- **The Stuck States queue no longer names members to an admin who cannot see
  the membership roll (#2823).** Two signals on the operator queue expand into a
  short list of the people or bookings behind the count — *Members with no
  reachable email address* names the members, and *Bookings without required
  adult member cover* names each booking's owner. Those named rows are
  membership-roll detail, but the Stuck States page sits in the Support area, so
  an admin with Support access but not Membership access was being shown them.

  Those named rows now appear only for an admin who also holds Membership view
  access — the same permission the Members admin already requires. An admin
  without it still sees the same signal, the same count, and the same **Open**
  link, so support staff can see a problem exists and hand it on; they just no
  longer see the individual names and per-member links.

  Nothing changes for an admin who can already view the membership roll.
