- **AI Diagnostics answers are now announced to screen readers, and keyboard focus
  is no longer stranded (#2379).** In the Help-bubble diagnostics tab, an arriving
  answer, a refusal, and the "budget spent" state used to reach a screen-reader
  operator as silence — only the "Looking into that…" progress line was announced.
  The transcript is now a polite live region, so answers and refusals are read out
  when they arrive, and after each question focus returns to the question box (or to
  "Start again" when a spent budget has disabled it) rather than being lost.
- **The AI Diagnostics documentation now matches the shipped product (#2379).** New
  `architecture.md` and `e2e-matrix.md` reference pages describe the end-to-end
  request path, the read-only database seams, the evidence channels, and the security
  verification coverage. A stale operator note that described the tool packs as
  "dormant" with "no production call site" has been corrected — the packs are live
  when the module is enabled and provisioned. Provider-disclosure, zero-retention, and
  the private knowledge overlay are documented honestly as **deferred, not implemented
  in this release**. The module remains off by default; nothing changes for a
  deployment that has not enabled it.
