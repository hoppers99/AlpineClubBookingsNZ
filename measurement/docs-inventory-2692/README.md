# Documentation inventory — pre-restructure snapshot (#2692)

Audience: agent, contributor

MEP-D1 (#2692) splits the documentation by audience. Its first acceptance
criterion is that the current tree and its inbound links are **recorded before
any page moves**, so that a visually tidy folder split cannot silently strand a
page. This directory is that record.

```bash
node measurement/docs-inventory-2692/build-inventory.mjs   # rewrites inventory.tsv
```

`inventory.tsv` is the machine-generated map: one row per root Markdown entry
point and per page under `docs/`, with its assigned audience, its distance from
the nearest reachability root, how many Markdown pages link to it, how many
**non-Markdown** files (source, tests, workflows, config) name its path, and how
many of its inbound links come from an index rather than from prose.

Re-run the script after a restructure and compare: that is the cheapest proof
that nothing was orphaned.

## What the snapshot said, at `addb5e65f`

| Measure | Count |
| --- | --- |
| Tracked Markdown files in the repository | 426 |
| Pages under `docs/` | 221 |
| Root Markdown entry points | 12 |
| Pages under `docs/` unreachable from a reachability root | 0 |
| Pages under `docs/` reachable but named by no index page | 4 |
| Root pages unreachable and named by no index page | 1 (`REVIEW.md`) |

The reachability roots are the five the CI index check walks from: `README.md`,
`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `docs/README.md`.

### The four index-orphans under `docs/`

Reachable only because some other content page happened to mention them:

- `docs/agents/codex/profiles/README.md` — reached from `agents/PROFILE_GUIDE.md`.
- `docs/agents/codex/skills/README.md` — reached from `agents/CODEX_PROMPTS.md`.
- `docs/lobby-display/decisions/ADR-001-device-pairing-auth-model.md` — reached
  from two sibling ADRs and `lobby-display/design.md`, but not from the
  lobby-display hub.
- `docs/lobby-display/decisions/ADR-002-template-model-and-storage.md` — same.

### The one true orphan

`REVIEW.md` at the repository root is linked from nowhere: not from `README.md`,
not from any hub, not from any source file. It is a dated production-hardening
review report from 15 July 2026.

## Why the audience split is delivered as indexes, not as a bulk relocation

The obvious physical shape — `docs/adopters/` and `docs/contributors/` holding
the flat `docs/*.md` reference layer — was costed against this snapshot and
rejected. Three measurements decided it:

1. **The flat layer is load-bearing for code, not just for readers.** The 29
   pages matching `docs/*.md` carry **251** inbound references from tracked
   non-Markdown files — test names, guard failure messages, workflow comments,
   `knip.jsonc` justifications, script docblocks. `docs/CONCURRENCY_AND_LOCKING.md`
   alone has 48, `docs/DOMAIN_INVARIANTS.md` 29, `docs/ARCHITECTURE.md` 19. A
   rename does not break these loudly; it breaks them silently.
2. **The five most-cited contributor pages cannot move right now.** Open
   High-risk PRs #2885 and #2892 hold edits to `docs/ARCHITECTURE.md`,
   `docs/CONCURRENCY_AND_LOCKING.md`, `docs/DOMAIN_INVARIANTS.md`,
   `docs/MAINTENANCE.md` and `docs/UX_FLOW_MAP.md`, among fourteen pages in
   total. Git records a move plus an edit as a rename-versus-edit conflict, so
   relocating them would force two capacity and concurrency PRs to re-resolve
   documentation churn.
3. **A half-moved tree is worse than either whole.** Because those five must
   stay put, moving their siblings would leave the *most* important contributor
   pages outside `docs/contributors/`. A reader who learns the new rule would
   then be wrong about the pages that matter most.

Nothing was orphaned before the restructure, so the split's job was never to
rescue stranded pages: it was to give each audience one entry point it can read
end to end without wading through the other's material. Indexes do that in full,
and acceptance criterion 3 asks for reachability from a canonical index rather
than for relocation as such.

The deferred destinations are recorded in the pull request that delivers #2692,
so the move can follow once #2885 and #2892 have landed.
