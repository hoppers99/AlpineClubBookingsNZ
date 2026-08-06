- **Hosting-cover follow-up work now survives overlapping workers and policy/member
  merges (#2596).** Re-evaluation and owner-email delivery use short opaque claims;
  only the current exact claimant can renew, finish or release work, and lock or
  notification contention no longer consumes the retry budget. If a worker crashes,
  another can safely retry. Delivery remains at-least-once, so an ambiguous provider
  completion may duplicate a notice rather than silently lose it.

  Policy reconciliation and member merge now share one ordered policy-set lock,
  claimed owner, actor and source facts are refreshed before incident attribution,
  and a source booking is treated as cancelled only after a direct lifecycle lookup
  rather than because it fell outside a capped dependent list. Booking Officer
  incident totals and lists remain scoped to the selected lodge.

  The claim-token migration requires a stopped-old-runtime maintenance window.
  Ordinary booking/member queue producers still require the participant-handshake
  work in #2597 before downstream deployment; policy/config-transfer bulk
  reconciliation is already fenced here.
