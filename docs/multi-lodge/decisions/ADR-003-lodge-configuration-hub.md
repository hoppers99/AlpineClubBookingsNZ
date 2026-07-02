# ADR-003: Lodge Configuration Hub Over a Lodge-Centric Navigation Restructure

## Status

Accepted (owner direction, 2026-07-02).

## Context

Phase 7 (ADR-002) retrofitted the existing admin configuration pages —
rooms/beds, lockers, seasons/rates, chores — with a per-page lodge context
selector that renders nothing while fewer than two lodges exist. That
satisfied the single-lodge presentation rule cheaply, but it leaves the
lodge dimension scattered:

- The selected lodge is page-local component state; every page starts on
  the default lodge and the admin re-selects on each page.
- The selector's placement drifted between pages.
- Setting up a new lodge means discovering, one page at a time, every
  place that needs per-lodge configuration. Nothing shows at a glance
  what a lodge still needs (no beds yet, no seasons yet).
- The add-N-of-a-thing forms (rooms, beds, lockers) create one row per
  submit, which makes initial setup of a whole lodge tedious.

A full lodge-centric information architecture — nesting the configuration
pages under `/admin/lodges/[id]/...` — was considered. It reads well for
setup, but it would give single-lodge deployments (the common case,
including upstream) a different URL structure and navigation than today,
force either two navigation trees or a violation of the ADR-002
presentation rule, and churn pages upstream has already reviewed. It also
fits day-to-day use poorly: after setup, "adjust this winter's rates" is
a rates task, not a lodge task.

## Decision

Keep the configuration pages where they are and add a **lodge
configuration hub** on top, plus shared conventions that make the lodge
context consistent:

1. **Hub page** at `/admin/lodges/[id]` (inside the `multiLodge`-gated
   `/admin/lodges` route family, so single-lodge clubs never see it).
   It shows the lodge's identity fields and one card per configuration
   area — rooms & beds (with bed count and resolved capacity), lockers,
   seasons & rates, chores — each with a live summary count and a link to
   the existing page pre-filtered to that lodge. Cards for module-gated
   areas render only when their module is enabled. The hub is the "what
   does this lodge still need?" view; the existing pages stay the place
   where the work happens.
2. **URL-driven lodge context.** The configuration pages initialise their
   lodge selector from a `?lodgeId=` query parameter so hub links land
   pre-filtered. The selector remains for switching without leaving the
   page.
3. **One placement convention.** The lodge selector renders in a single
   consistent slot — its own row directly under the page heading — on
   every retrofitted page.
4. **Bulk seeding.** The rooms/beds and lockers admin APIs gain bulk
   endpoints ("N rooms of M beds", "N lockers") with a name prefix, used
   by quick-add forms on those pages. Generated names respect the current
   global uniqueness constraints (ADR-001: `[lodgeId, name]` re-scoping
   arrives with the phase-2 contract release), so a clashing prefix is
   rejected with a clear error rather than half-applied — creation is
   transactional.

A guided "new lodge" wizard (create → beds → lockers → rates → chores,
with copy-from-existing-lodge) remains a recorded future enhancement in
the implementation plan; the hub gives most of its value at a fraction of
the surface, and phase 3's capacity rule (an unconfigured lodge resolves
to capacity 0) means there is no safety pressure to force setup through a
wizard.

## Consequences

### Positive

- One place to see and drive a lodge's setup; adding a lodge no longer
  requires knowing the full page list by heart.
- No URL or navigation change for single-lodge deployments; the ADR-002
  presentation rule holds untouched.
- Bulk seeding removes the copy/paste grind for the common "8 rooms of
  4 beds" case while keeping the existing one-at-a-time forms for
  fine-grained edits.
- Existing pages, permissions, and API guards are reused; the hub is a
  read-mostly composition over already-guarded endpoints.

### Negative

- The lodge dimension lives in two navigation contexts (functional pages
  plus the hub), which costs some conceptual purity.
- Hub summaries are extra reads per visit (one list call per area).
- Bulk-generated default names can collide with existing rooms/lockers at
  other lodges until the contract release re-scopes uniqueness; admins
  may need to adjust the prefix at a second lodge.
