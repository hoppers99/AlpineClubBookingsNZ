- **Diagnostics answers now say when a provider value is stored rather than live
  (#2815).** The finance tools read what this platform last recorded of Stripe and
  Xero state — never the provider's live answer — and every answer built on such a
  read now carries that caveat on its one-line provenance summary: "provider values
  are as last recorded here — confirm against Stripe or Xero's own console before
  acting on them". Previously a stored SUCCEEDED could read like a live confirmation.
