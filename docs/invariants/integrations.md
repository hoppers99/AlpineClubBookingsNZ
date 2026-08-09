# Integrations

> **Phase 2 transcription — issue #2691.** Until the index rewrite lands,
> [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) remains the authoritative
> copy of these rules and this file duplicates its "Integrations"
> section. Do not edit either copy independently while both exist. The scheme this
> file follows is in [`_PHASE1_SCHEME.md`](_PHASE1_SCHEME.md).

Audience: Developer, Agent.

Index: [`docs/DOMAIN_INVARIANTS.md`](../DOMAIN_INVARIANTS.md) · Scheme and
allocation rules: [`_PHASE1_SCHEME.md`](_PHASE1_SCHEME.md).

Prefix defined in this file: **`INV-INT`** (webhooks and cron idempotency,
provider callback verification, what may appear in logs and webhook records, and
Xero member contact-group grouping).

Read this file when you are changing a webhook, a cron job, a provider callback,
what is logged about an integration, or Xero contact-group grouping.

`INV-XERO` is deliberately not a prefix: the `INV-` namespace already carries
Xero invoice-number test fixtures, so the Xero grouping rules take `INV-INT`
alongside the rest of Integrations. See §1.2.1 of the scheme.

Every `##`/`###` heading below whose whole text is an ID is an invariant ID. IDs
are permanent and are never renumbered — see the allocation rules in the scheme.
The text under each ID is copied verbatim from `docs/DOMAIN_INVARIANTS.md`; only
the ID heading lines were added.

## INV-INT-001

- Webhooks and cron jobs must be idempotent.

## INV-INT-002

- Provider callbacks must verify signatures, state, or expected origin before
  local mutation.

## INV-INT-003

- External provider calls should not be placed inside long database
  transactions unless there is a documented reason.

## INV-INT-004

- Email, Xero, and payment failures that affect business-critical outcomes must
  be visible and retryable.

## INV-INT-005

- Logs, webhook records, Sentry events, and PR comments must not expose secrets,
  OAuth codes/states, action tokens, client secrets, or personal data beyond the
  minimum needed for diagnosis.

## Xero member grouping (E8, #1934)

### INV-INT-006

- A single club-level mode governs member auto-grouping: `NONE`,
  `MEMBERSHIP_TYPE`, or `MEMBERSHIP_TYPE_AND_AGE` (`XeroGroupingSettings`
  singleton). Grouping rules live in one table, `XeroContactGroupRule`
  (`MANAGED` = the group the sync adds; `ACCEPTED` = tolerated, never removed).

### INV-INT-007

- The system NEVER deletes a Xero contact group. It only adds/removes a
  contact's *membership* of groups in the "managed universe" = groupIds
  referenced by ACTIVE rules that are applicable under the current mode.
  Xero groups not referenced by any active rule are never touched.

### INV-INT-008

- `NONE` mode is a total no-op — the per-member sync short-circuits before any
  Xero call, and the cancellation path performs no managed removals.

### INV-INT-009

- A rule targets a **set** of age tiers (`ageTiers`, #2093): the EMPTY set is
  the "all age tiers" wildcard (the migrated null "Any age"); a non-empty set
  matches a member whose tier is IN the set. Sets are stored canonical-sorted and
  a full-tier selection collapses to the empty set, so each shape has exactly one
  canonical form and the DB partial unique index dedupes reordered sets. In
  `MEMBERSHIP_TYPE` mode a non-empty tier set makes the rule inert.

### INV-INT-010

- Resolution is pure and mode-driven (`resolveMemberGrouping`): most-specific
  MANAGED match wins on the ladder `type + tiers` > `type-only` > `tiers-only`;
  among tiered rules **fewer tiers is more specific**, and an all-tiers (`[]`)
  rule is the LEAST specific in the tier dimension (a naive ascending
  tier-count comparator would wrongly invert this). Exact ties break
  deterministically by `sortOrder` then group id. ACCEPTED is the union
  of matching accepted rules plus the matched managed group. The effective
  membership type is resolved by the ONE shared policy helper
  (`resolveMembershipTypePolicyForMember`) at the CURRENT season year — pricing
  resolves per stay-night season, grouping resolves at "now"; the two must not
  be merged.

### INV-INT-011

- Add-suppression: the managed group is added only when the contact is in NONE
  of (matched MANAGED ∪ matched ACCEPTED), so members parked in an accepted
  group get no spurious add. A member matching no rule is left untouched (no
  removals); when such a member sits in managed-universe group(s) they surface
  as an information-only entry in the dry-run snapshot (never iterated by the
  bulk re-sync) for deliberate admin cleanup in Xero.

### INV-INT-012

- The cutover migration deactivates every pre-existing `XeroContactGroupRule`
  row it did not backfill itself, so only tier-only backfill rules are live at
  deploy; dormant legacy rules require a deliberate admin re-enable via the
  grouping UI.

### INV-INT-013

- Mode/rule changes NEVER auto-resync the population. Deactivating or deleting a
  rule shrinks the managed universe, so members already in that group are never
  removed by the system. Members re-group on their next trigger (age-tier
  change, current-season membership-type change, cron age-up) or via the
  explicit admin bulk re-sync.

### INV-INT-014

- The per-member sync keeps Xero calls outside DB transactions, ledgers each
  operation with an idempotency key (the per-add key carries a per-operation
  nonce so a legitimate later re-add is never swallowed by Xero's 24h
  idempotency window), adds before removing, and refreshes the contact cache
  from the post-write contact. A remove-404 is idempotent success recorded as
  already-absent — never counted as a removal; an add-404 is a ledgered
  failure.

### INV-INT-015

- The bulk re-sync is admin-triggered, dry-run-first, cache-pre-filtered to
  mismatched members, chunked and resumable by member-id cursor, and never
  advances the CONTACT delta-sync watermark. Members without a Xero contact are
  reported as skipped, never silently omitted.
