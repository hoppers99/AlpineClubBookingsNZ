- **Hosting-cover follow-up work can no longer be consumed by an expired worker
  (#2596).** Re-evaluation and owner-email delivery now use short, opaque claims;
  only the worker holding the current claim can finish or release it. If a worker
  crashes, another can retry after the lease expires without the stale worker
  overwriting the retry. Work is claimed one row at a time; an exact notification
  claimant renews just before delivery, while a replaced token stops before the
  provider call. A transient unreadable booking email flag
  remains retryable without turning intentional suppression into a poison item.
  Delivery is at-least-once: an ambiguous crash after provider acceptance may retry
  the notice rather than silently lose it. The claim-token migration now requires
  an explicit stopped-old-runtime maintenance
  window because an old worker does not understand the new fencing protocol. Booking
  Officer incident totals and lists also stay within the lodge selected on the
  bookings screen. A separate public blocker (#2597) owns the broader queue-writer
  versus member-merge participant topology and must land before the downstream
  Tokoroa deployment.
