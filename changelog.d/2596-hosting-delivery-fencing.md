- **Hosting-cover follow-up work can no longer be consumed by an expired worker
  (#2596).** Re-evaluation and owner-email delivery now use short, opaque claims;
  only the worker holding the current claim can finish or release it. If a worker
  crashes, another can retry after the lease expires without the stale worker
  overwriting the retry. Booking Officer incident totals and lists also stay within
  the lodge selected on the bookings screen.
