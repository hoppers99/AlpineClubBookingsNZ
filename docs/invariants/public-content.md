# Public authoritative content

> **Phase 2 transcription — issue #2691.** Until the index at
> [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) is rewritten, that file
> remains the authoritative copy of these rules and this file duplicates its
> "Public authoritative content" section. Do not edit either copy independently
> while both exist. The scheme this file follows is in
> [`_PHASE1_SCHEME.md`](_PHASE1_SCHEME.md).

Audience: Developer, Agent.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) · Scheme and
allocation rules: [`_PHASE1_SCHEME.md`](_PHASE1_SCHEME.md).

Prefix defined in this file: **`INV-PUB`** (what the public site is allowed to
publish: fee and policy page content, effective-dated public fees, and lodge
token resolution).

Read this file when you are changing public fee or policy page content, public
fee resolution, or named lodge tokens and the view models built from them.

The source section has no subsections, so every `##` heading below is an
invariant ID. IDs are permanent and are never renumbered — see the allocation
rules in the scheme. The text under each ID is copied verbatim from
`docs/DOMAIN_INVARIANTS.md`; only the ID heading lines were added.

## INV-PUB-001

- Fee/policy PageContent blocks are explicitly enabled and server-rendered; a
  token alone publishes nothing.

## INV-PUB-002

- Public fees use current effective-dated schedules. Joining fees resolve from
  the `JoiningFee` schedule (membership type × age tier) only — no legacy Xero
  mapping-amount fallback.

## INV-PUB-003

- Named lodge tokens resolve exactly one active lodge or no data, never the
  default lodge. Public view models exclude ids, provider codes, and secrets.
