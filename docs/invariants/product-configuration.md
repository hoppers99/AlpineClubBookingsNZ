# Product configuration

Audience: Developer, Agent.

Prefix defined in this file: **`INV-CONFIG`** — the product stays generic. What
varies between clubs gets a configuration surface rather than a constant, an
upgrade that adds one falls back safely, and an unconfigured state is visible
where an operator has to act.

Read this file when you are adding a value or a feature a club could reasonably
want differently from ours, introducing a new setting that existing deployments
will not have, or deciding whether a question is an owner decision or a
configuration surface you have not recognised yet.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) — every `INV-*` ID
with a one-line description of what it covers. ID scheme and allocation rules:
[`SCHEME.md`](SCHEME.md).

Every heading below whose whole text is an `INV-*` ID defines that invariant. IDs
are permanent: never renumbered, never reused.

The practical guide to the levers — module toggle, setting, seed default, and
the code change that builds a new surface — is
[`configure-or-fork.md`](../adopters/configure-or-fork.md), which is the one
home for that explanation and is not repeated here.

## INV-CONFIG-001

- **A club-varying value gets a configuration surface, not a constant.** Each
  deployment serves exactly one club, and this repository is the generic
  product: it must never encode which club. The test is *would a different club
  answer this differently?* — if yes, the answer is a module toggle, a setting
  or a seed default. This is about what the code hard-codes, not about runtime
  tenancy; one deployment still serves one club.
- **An upgrade that introduces a setting falls back to a documented default
  rather than hard-failing because the setting is absent.** An existing
  deployment upgrades without an operator having to configure the new value
  first, wherever a safe default exists.
- **Where the operator does have to act, the unconfigured state is visible** —
  the readiness badge, the setup checklist or the system health page — instead
  of failing silently at the point of use.
- Decided on #2717 (a distinct configurable Xero EXPENSE mapping with a safe
  fallback), generalised in #2720. Those issues hold the narrative, the options
  and the rejected alternatives; this entry holds only the rule.
