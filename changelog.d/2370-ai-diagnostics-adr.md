- **The security and privacy contracts for the planned AI Diagnostics assistant
  are now written down (#2370).** AI Diagnostics will be a separate, admin-only
  assistant that can read (never change) deployed code and permission-scoped
  operational evidence to help an operator understand the live system — distinct
  from the existing member-facing AI Help assistant.

  This change ships design documentation only — no behaviour changes yet. It adds
  a documentation hub, eight architecture decision records, and a STRIDE threat
  model under `docs/ai-diagnostics/` that fix the admission rules, the read-only
  prohibitions, the untrusted-evidence handling, retention and redaction, the
  spend budget and rate limits, the deployment/fork contract, a
  least-privilege read-only database credential, and the inert-render/strict-CSP
  answer output channel. These contracts bind the
  implementation work that follows: none of it may weaken them without an owner
  decision recorded on the relevant issue.
