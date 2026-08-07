- **The end-to-end tests that create a booking now watch each create through to
  its own result, which should make the hosted test runs less flaky (#2610).**
  Nothing about booking changed. The test harness used to stop watching a
  booking-create request the instant the button click returned, which on the
  hosted runners sometimes overlapped the page navigation that same click had
  just started — and the run failed with the new booking's page never arriving.

  Each of the fourteen browser journeys that create a booking now names the
  outcome it is really waiting for — the new booking's own page, the payment
  step, or the refusal it expected — and the harness keeps watching until that
  outcome is on screen. A side benefit is that a second, unexpected create
  arriving during that window is now caught instead of going unnoticed.

  This is deliberately being measured rather than declared fixed: the failure has
  never once reproduced outside the hosted runners, so the change is harness
  hygiene plus the experiment that tells us whether it was the cause.
