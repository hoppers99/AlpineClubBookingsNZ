# Codex Workflow

Use this workflow for future Codex work in AlpineClubBookingsNZ. It is designed
for issue-scoped, auditable changes in a public repository with payment,
accounting, membership, and booking risk.

## Standard Flow

1. Read `AGENTS.md`.
2. Read the GitHub Issue or human task.
3. Read the relevant docs named by the issue and the nearest domain docs.
4. Create one branch for the issue.
5. Work only inside issue scope.
6. Add or update tests where practical.
7. Run required validation.
8. Review your own diff for scope, secrets, data integrity, and docs drift.
9. Open a PR using `.github/pull_request_template.md`.
10. Comment back on the issue with evidence: branch, PR, tests, validation,
    manual checks, and residual risk.
11. Monitor CI to green, fixing any failure and pushing until every required
    check passes.
12. Merge per the `AGENTS.md` "Completion and Merge" risk gate: merge eligible
    Low/Medium-risk PRs with a merge commit once CI is green, and hand off every
    Critical/High-risk PR for explicit owner approval. Never squash or
    force-push. Delete the branch after merge; a linked issue closes only when
    its PR is eligible and merged.

## Planning Mode

Use planning mode for broad reviews, high-risk changes, ambiguous issues, or
when deciding how to split work. Planning output should include context files,
proposed issue splits, risk labels, validation, manual checks, and stop
conditions. Planning mode must not edit app logic.

## Context and execution economy

The shared quota, context, risk-tiered blueprint, proportional-validation and
two-attempt failure controls live once in root `AGENTS.md`. Apply them before
expanding a plan or delegating work. In Codex, pick the tier at dispatch rather
than from a name written here: run a local repository tool when it answers the
question exactly, otherwise take the cheapest tier you would trust without
re-checking its work, and raise reasoning effort before reaching for a larger
model. Preserve the strongest-model high/xhigh handling for gated areas, state
the model and effort when you delegate, keep subagent prompts bounded, and clear
issue-specific context before switching lanes.

When the routed docs are known but the code neighbourhood is not, generate the
tracked-only locator documented in
[`SCOPED_CONTEXT.md`](SCOPED_CONTEXT.md):

```text
npm run agent:context -- -- --base origin/main --entry <tracked-path> [--depth 1|2]
```

Give a subagent only the relevant section or local artifact path, never a full
repository dump. Prefer `rg`, Git and repository scripts over a browser or MCP
round trip when they provide the same evidence. The mapper is shared with
Claude Code; it does not replace the always-read core, issue thread, routing
table, or validation gate.

## Coding Mode

Use coding mode only after scope is clear. Keep the change narrow, follow the
existing module boundaries in `docs/ARCHITECTURE.md`, and preserve the domain
invariants: read the `docs/DOMAIN_INVARIANTS.md` index and the `INV-*` files its
routing table sends you to for the surfaces you touch, and cite `INV-*` ids
rather than line numbers. If implementation needs schema,
payment, booking, membership, or provider behavior beyond the issue, stop and
report the mismatch.

## Review Mode

Use review mode for PRs, local diffs, or generated plans. Findings should lead
the response, ordered by severity, with file and line references where
available. Review mode should not apply fixes unless the user asks.

## Subagents

Follow `AGENTS.md` -> "Orchestration Model". The main session owns issue claims,
worktrees, GitHub writes, PRs, CI, risk gates, merges, and cross-lane conflict
checks. Delegate bulk implementation to implementor subagents inside the
issue's dedicated worktree; they commit locally but never push or touch GitHub.
Before opening a PR, dispatch separate adversarial-review subagents with
appropriate correctness, domain-invariant, drift, and UX/security lenses.

Parallel implementation lanes are allowed only when their code surfaces do
not clash. The orchestrator must inspect open work and coordinate before
claiming a lane. A small in-flight edit may stay with the orchestrator, but
this does not remove the adversarial-review requirement for gated work.

## Windows worktree runtime and dependency preflight

Run this before delegating validation in every new Windows worktree. The
orchestrator coordinates it; implementors must not start competing installs or
use an `npx` fallback that downloads an unreviewed package.

### 1. Activate and verify the pinned Node runtime

The default shell may expose system Node 22 even when `fnm` has Node 24.
Initialise `fnm` inside the same PowerShell process that will run npm, use the
repository's `.nvmrc`, and fail closed if either engine is wrong:

```powershell
fnm env --shell powershell | Out-String | Invoke-Expression
fnm use --install-if-missing

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
$npmMajor = [int](npm --version).Split('.')[0]
if ($nodeMajor -ne 24 -or $npmMajor -lt 11) {
  throw "Expected Node 24 and npm 11+, got Node $nodeMajor and npm $npmMajor"
}
```

Repeat the activation prefix in every fresh PowerShell validation shell; shell
state does not carry between tool calls.

### 2. Require an isolated dependency tree

Every active branch owns a physical `node_modules` inside its own worktree.
Never junction or symlink it to another checkout. Prisma generation writes the
branch's client into `node_modules/@prisma/client`; a shared dependency tree lets
one lane silently change another lane's types. npm's cache is already shared and
provides download reuse without sharing mutable generated output.

Before installing, inspect any existing entry and refuse reparse points:

```powershell
$worktree = (Resolve-Path -LiteralPath $PWD).Path
$modules = Join-Path $worktree "node_modules"
if (Test-Path -LiteralPath $modules) {
  $modulesItem = Get-Item -LiteralPath $modules -Force
  if (($modulesItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing shared/reparse-point node_modules at $modules"
  }
}
```

On Windows, a direct `npm ci` has reproduced a race that starts
`unrs-resolver` before its locked `napi-postinstall` helper is available. Use the
verified two-phase install: extract the exact lockfile without scripts, then
rebuild only the reviewed packages whose install scripts this lockfile needs.
If `package-lock.json` changes or npm reports a different script-package list,
stop for review instead of extending it by guesswork.

```powershell
npm ci --ignore-scripts
npm rebuild @prisma/engines @sentry/cli core-js esbuild prisma unrs-resolver

$env:DATABASE_URL = "postgresql://codex:codex@127.0.0.1:5432/codex_local"
npm run db:generate

if (-not (Test-Path -LiteralPath "node_modules/.bin/prisma.cmd") -or
    -not (Test-Path -LiteralPath "node_modules/.bin/vitest.cmd")) {
  throw "Dependency preflight did not produce the required local binaries"
}
```

The placeholder URL is non-live and generation does not connect to it. Use a
separately provisioned local test database only for commands that actually need
a connection; never substitute production or provider credentials.

### 3. Remove worktrees without traversing old junctions

New lanes must not create dependency junctions. Before removing any older
worktree, however, inspect `node_modules`. PowerShell `Remove-Item` throws on a
junction in the supported environment, while `git worktree remove` can follow
one and erase the shared target. Verify the exact expected target, unlink only
the junction with the non-recursive .NET call, and prove the target survived:

```powershell
$ErrorActionPreference = "Stop"
$worktree = (Resolve-Path -LiteralPath "C:\path\to\exact-worktree").Path
$modules = Join-Path $worktree "node_modules"
$expectedTarget = (Resolve-Path -LiteralPath "C:\path\to\expected\node_modules").Path

if (Test-Path -LiteralPath $modules) {
  $modulesItem = Get-Item -LiteralPath $modules -Force
  if (($modulesItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    if ($modulesItem.LinkType -ne "Junction") {
      throw "Refusing to unlink non-junction reparse point at $modules"
    }
    $rawTarget = [string]($modulesItem.Target | Select-Object -First 1)
    $separator = [IO.Path]::DirectorySeparatorChar
    $altSeparator = [IO.Path]::AltDirectorySeparatorChar
    $isDriveAbsolute =
      $rawTarget.Length -ge 3 -and
      [char]::IsLetter($rawTarget[0]) -and
      $rawTarget[1] -eq ':' -and
      ($rawTarget[2] -eq $separator -or $rawTarget[2] -eq $altSeparator)
    $isUncAbsolute = $rawTarget.StartsWith("$separator$separator")
    if (-not ($isDriveAbsolute -or $isUncAbsolute)) {
      throw "Refusing non-absolute junction target $rawTarget"
    }
    $actualTarget = [IO.Path]::GetFullPath($rawTarget)
    if ($actualTarget.TrimEnd($separator) -ne $expectedTarget.TrimEnd($separator)) {
      throw "Refusing unexpected junction target $actualTarget"
    }
    $targetSentinel = Join-Path $expectedTarget ".bin/prisma.cmd"
    if (-not (Test-Path -LiteralPath $targetSentinel)) {
      throw "Refusing to unlink: expected target sentinel is missing"
    }
    [IO.Directory]::Delete($modules)
    if ((Test-Path -LiteralPath $modules) -or
        -not (Test-Path -LiteralPath $targetSentinel)) {
      throw "Junction unlink failed or damaged its target"
    }
  }
}
```

Only then verify the worktree is clean, its head is merged into the intended
base, and run `git worktree remove` on that exact path. Do not use `-Force` to
paper over a failed safety check.

### 4. Preserve progress while lanes run

Long-running implementors keep a checkpoint outside the worktree and update it
after every material investigation, edit, test, and commit. Commit coherent
stages locally before an expected session or usage boundary. While CI runs, the
orchestrator uses free agent slots for independent dependency-ready lanes or
reviews, but never overlaps colliding work simply to maximise slot count.

### 5. Split fast local evidence from full CI gates

Before push, run the branch-correct Prisma generation, lint, typecheck, focused
touched/adjacent tests, and mutation checks for every new guard. Add docs
linkcheck when documentation changes and knip when files or exports change.
These fast checks catch branch-specific mistakes before they consume a runner.

Push a draft PR after that evidence is green. GitHub Actions owns the full
`npm test`, build, migration-drift, E2E, static/secret/dependency, and container
gates. Do not delay a draft PR just to duplicate those full gates locally; the
public repository's CI minutes are the standard execution path. Run a full
suite locally only to diagnose a CI failure or when CI is unavailable, and
record the reason and result in the PR.

For concurrency-sensitive work, the orchestrator also reviews the open PRs and
last 10 merged PRs affecting the subsystem, reconciles their lock/state/provider
contracts, and records the relevant PR numbers in the PR lock-impact section.
Root `AGENTS.md` is authoritative if this workflow ever drifts again.

The `agent-workflow-contract.test.ts` verification test pins these entry-point
links and PR evidence fields. A change that removes or contradicts the shared
workflow must update the canonical contract deliberately instead of allowing
agent-specific guidance to drift silently.

## Stop Conditions

Stop and ask for human review when:

- The issue conflicts with `AGENTS.md`, security policy, or domain invariants.
- The required change appears to need production credentials, production data,
  live provider calls, live webhooks, or production backups.
- A high or critical risk issue asks for unattended coding.
- The issue asks to bypass tests, hide evidence, reveal secrets, widen
  permissions, or merge or close Critical/High-risk work without the owner
  approval required by the "Completion and Merge" risk gate.
- The repo state suggests prerequisite work is not merged.

## Documentation

Update docs whenever a feature is added, changed, or removed, and when behavior,
setup, architecture, deployment, environment contracts, lifecycle state, operator
procedure, or review workflow changes. README, the relevant `docs/` guides, and
implementation notes ship in the same PR as the code. Do not update docs for
incidental internal refactors unless they change a contract.

Codex workflow and label examples are documentation-only fixtures under
`docs/agents/examples/`. Do not copy them into `.github/workflows/` or
`.github/labels/` without human review of permissions, triggers, and labels.

## Residual Risk Reporting

Every PR or review handoff should state:

- What was validated.
- What was not validated and why.
- Whether live providers, production credentials, or production data were used.
- Remaining operational dependencies, manual checks, or follow-up issues.
