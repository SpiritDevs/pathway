# 22 — Version Control Phase 3: Git Client & Workflow Modes

## Goal

Turn Pathway's version-control surface from "commit/push/PR pipeline attached to a thread" into a first-class Git client (reference: Tower, Graphite), plus a user-selectable **git method** that controls how thread changes are published — `core_git` (one branch per thread, PR grows) or `graphite` (stacked PRs: each change gets its own branch/commit/PR based on the previous one).

Prompted by a real failure: repeated "Commit, push & PR" on a branch with an existing PR errored with "GitHub CLI command failed." Root causes (fixed separately, pre-phase-3): `isCrossRepository` false-positive when no remote is named `origin` (`apps/server/src/git/GitManager.ts:1161-1168` + match filter `:349-352`), no already-exists recovery in `runPrStep`, and gh stderr dropped from error details (`apps/server/src/sourceControl/GitHubCli.ts:71-73`).

## Scope

1. Server: complete the `GitVcsDriver` operation set (history, index/staging incl. per-hunk, stash, cherry-pick/merge/rebase/revert/reset with conflict handling, remote management, push/pull variants).
2. Contracts + RPC: schemas and WS methods for all of the above, following plan 19 naming rules.
3. Web UI: a repo-scoped Source Control area with Working Copy, History (commit graph), Branches, Remotes, Stashes views; drag-and-drop cherry-pick/merge; context menus.
4. Settings: `sourceControlWorkflow` mode (`core_git` | `graphite`) with global default + per-project override; Graphite mode executes via the `gt` CLI.

## Non-Goals

- No Jujutsu implementation of the new operations (capability-gated; jj continues to report unsupported).
- No reimplementation of Graphite's restack engine — Graphite mode requires the `gt` CLI; absence is detected and reported, not emulated.
- No interactive rebase editor (reorder/squash UI) in this phase; single-target rebase only.
- No mobile parity in this phase (mobile keeps its existing git sheets).
- No changes to the PR review surfaces (plan 20's contracts stand).

## Naming (binding, per plan 19)

Provider-neutral nouns on shared contracts: `ChangeSet` (a commit), `RefName`, `WorkingCopyStatus`. Git-only operations live on `GitVcsDriver` (not `VcsDriver`) and may use git vocabulary (`stash`, `cherryPick`, `rebase`). Capability flags (`VcsDriverCapabilities`, `packages/contracts/src/vcs.ts:22`) gate every UI affordance; the UI must render from capabilities, never from `kind === "git"`.

---

## Part 1 — Server foundations (GitVcsDriverCore)

All new ops land on `GitVcsDriver` (`apps/server/src/vcs/GitVcsDriver.ts:240-336`), implemented in `GitVcsDriverCore.ts`, exposed via `GitWorkflowService` (`apps/server/src/git/GitWorkflowService.ts:35-108`) with the existing cache-invalidation hooks (`invalidateLocalStatus`/`invalidateRemoteStatus`), and surfaced through `ws.ts` handlers. Follow the `resolveRemoteNameForRef` idiom from commit 9796dda7d — never assume a remote named `origin`.

### 1a. History
- `log(input)`: paginated `git log --format` with stable cursor (skip+oid anchor), returning per-commit: oid, abbreviated oid, parents (for graph layout), author/committer name+email+date, subject, ref decorations (`%D`), and cheap stats opt-in. Batched (200/page) — History view virtualizes over 8k+ commits.
- `showChangeSet(oid)`: commit detail — full message, parents, tree hash, changed files with status letters and +/− counts (`git show --numstat --name-status`), and per-file patch retrieval reusing the `ReviewDiffFileContents` shape (`packages/contracts/src/review.ts:28-43`).

### 1b. Working copy & index
- Enriched status: extend the local status shape (`packages/contracts/src/git.ts:196-217`) — today files are only `{path, insertions, deletions}`. Add: change kind (M/A/D/R/C/untracked), rename old→new path, and the staged/unstaged/conflicted partition (from `git status --porcelain=v2 -z`). Feed through `VcsStatusBroadcaster.streamStatus` (`apps/server/src/vcs/VcsStatusBroadcaster.ts:156-172`) so the Working Copy view is live-push, no polling.
- `stage(paths)` / `unstage(paths)` / `discardWorkingChanges(paths)` (discard captures a checkpoint first — see Safety).
- `applyPatch({patch, cached, reverse})` for hunk-level stage/unstage/discard (`git apply --cached [--reverse] -`), with the hunk text produced client-side from the already-parsed `@pierre/diffs` hunks.

### 1c. Graph mutations
- `cherryPick(oids[])`, `merge(ref, {ff})`, `rebase(onto)`, `revert(oid)`, `reset(oid, mode)`.
- Conflict model: any of these can leave the repo in a conflicted sequence state. Add `sequenceState()` (parses `.git` for CHERRY_PICK_HEAD/MERGE_HEAD/REBASE_HEAD + conflicted paths from status) and `continueSequence()` / `abortSequence()` / `skipSequence()`. Long ops emit progress mirroring `GitActionProgressEvent` (`packages/contracts/src/git.ts:447`).

### 1d. Stash
- `stashList/Push/Pop/Apply/Drop/Show` (`git stash … --porcelain` where available; `show -p` reuses diff contracts).

### 1e. Remotes & tracking
- Complete the set beyond `ensureRemote`/`remoteExists`/`listRemotes`: `addRemote`, `removeRemote`, `renameRemote`, `setRemoteUrl`, `pruneRemote`.
- `setBranchUpstream` already exists (`GitVcsDriver.ts:315`) — expose it over RPC (it isn't today).
- Expose `listRemotes` over RPC — `VcsListRemotesResult` already exists (`packages/contracts/src/vcs.ts:55-59`) but has no WS method. Cheapest win in the whole plan.

### 1f. Push/pull variants
- `push` gains: explicit refspec, `--force-with-lease` (never bare `--force`), delete-remote-branch. `pull` gains `--rebase` / `--ff-only` options.
- `deleteLocalBranch`/`renameBranch` exist; add `deleteRemoteBranch` (via push refspec) and expose over RPC.
- First-class `listWorktrees` (extract the porcelain parse buried in `listRefs`, `GitVcsDriverCore.ts:2455-2485`).

### Safety model
Destructive ops (discard, reset --hard, force-with-lease push, stash drop, sequence abort) capture a checkpoint via the existing `VcsCheckpointOps` (`apps/server/src/vcs/VcsDriver.ts:44-52`) before executing, and the resulting toast offers undo (restore checkpoint). This machinery already exists — this phase just makes it the standard preamble for destructive verbs.

---

## Part 2 — Contracts & RPC

In `packages/contracts`:
- `git.ts`: `ChangeSetSummary` (oid, parents, author, date, subject, refs), `VcsLogInput/Result` (cursor), `VcsShowChangeSetInput/Result`, enriched `VcsStatusLocalShape` (change kinds + partition), `VcsHunkApplyInput`, stash schemas, sequence-state schema, remote-management inputs. Reuse `PullRequestCommit` (`pullRequest.ts:168-181`) only as a naming reference — history commits get their own repo-scoped schema.
- `rpc.ts` `WS_METHODS` (`:349-457`) + defs; handlers in `apps/server/src/ws.ts` (`:1790-1947`): `vcs.log`, `vcs.showChangeSet`, `vcs.stage`, `vcs.unstage`, `vcs.discard`, `vcs.applyPatch`, `vcs.stash*`, `vcs.cherryPick`, `vcs.merge`, `vcs.rebase`, `vcs.revert`, `vcs.reset`, `vcs.sequence*`, `vcs.deleteRef`, `vcs.renameRef`, `vcs.setUpstream`, `vcs.listRemotes`, `vcs.remote*`, `vcs.listWorktrees`.
- Client runtime: extend `createVcsEnvironmentAtoms`/`createVcsActionManager` (`packages/client-runtime/src/state/vcs.ts:236-336`) with the new commands (same `vcsCommandScheduler` + `invalidateRefs` pattern) and a paginated log atom family modeled on `listRefs`'s cached atom (`:237-269`).

## Part 3 — Web UI

New route `/source-control` (repo-scoped, per selected project/environment) added to `SecondarySidebarKind` routing (`apps/web/src/components/secondarySidebar.ts:31-33`). Replace the placeholder `SourceControlSidebar.tsx` (23 lines) with the real navigator.

### 3a. Sidebar (Tower-style navigator)
Sections: Working Copy (changed-count badge from live status), History, Stashes, Pull Requests (links to existing `/pull-requests`), Settings (links to `/settings/source-control`). Below: **Branches** tree grouped by `/`-prefix folders with HEAD marker and per-branch badges (merged state, ahead/behind from `listRefs` + status remote shape); **Tags**; **Remotes** tree (each remote expands to its branches — `listRefs` already returns remote refs). Reuse `ui/sidebar.tsx` groups + `@pierre/trees` icons; virtualize long branch lists with `@legendapp/list` (precedent: `BranchToolbarBranchSelector.tsx:866`).

### 3b. Working Copy view
Two-pane: changed-file list (staged / unstaged / conflicted sections, M/A/D/R chips) + diff of selection. Reuse `DiffPanel`'s rendering stack (`apps/web/src/components/DiffPanel.tsx`, `@pierre/diffs` worker pool); add per-hunk gutter actions (Stage/Unstage/Discard chunk) layered the way `AnnotatableCodeView.tsx` injects annotations. Commit composer: subject + body, Stage All, Commit button; reuse commit-message generation from the existing stacked-action machinery. `GitActionsControl`'s dialog flow stays for thread-scoped quick actions; the Working Copy view is the standing surface.

### 3c. History view
Virtualized commit timeline (LegendList) with a hand-rolled SVG lane graph (no graph lib exists; precedent for bespoke SVG: `MilestonesTimeline.tsx`, `MilestoneBurnUpChart.tsx`). Lane assignment computed incrementally from parent oids as pages stream in (standard straight-line lane algorithm; colors per lane, merge edges curved). Rows: avatar (gravatar-hash or provider avatar when available), subject, ref badges, date groups. Detail panel on selection: full metadata (author/committer/dates/refs/hashes/parents), message, changeset file list with status chips, per-file diff drill-in (Changeset/Tree tabs). Search filters subject/author/oid.

### 3d. Branch, remote, tracking management
- Create branch (exists — `createRef`), rename, delete (with checkpoint-backed confirm), checkout on double-click.
- Remote management dialog: add/remove/rename/set-url; per-branch tracking control (upstream picker → `setUpstream`).
- Context menus on branches/commits/remotes: use the native `ContextMenuItem` path with `contextMenuFallback.ts` (precedent: `IssueContextMenu.tsx`) so desktop gets OS menus.

### 3e. Drag-and-drop graph interactions
dnd-kit is already a dependency (`apps/web/package.json:18-21`); every current use is same-container sorting (Issues board is the nearest precedent) — cross-container drops are new. Interactions:
- Drag commit(s) from History → branch in sidebar = cherry-pick onto that branch.
- Drag branch → branch = merge (modifier key or drop-menu chooses merge vs rebase).
- Every drop opens a confirm dialog stating the exact operation; conflicts route to the conflict banner (sequence state) with continue/abort and per-file "open in Working Copy" resolution.

## Part 4 — Git method setting (workflow modes)

- New enum `SourceControlWorkflowMode = "core_git" | "graphite"` in `packages/contracts/src/settings.ts` beside `SourceControlWritingStyleMode` (`:553`); field on `ServerSettings` (~`:764`) **and** the hand-written `ServerSettingsPatch` (~`:886`). Default `core_git`.
- NOT a `VcsDriverKind` — Graphite wraps git; adding it as a driver would leak into repo detection and discovery.
- Scope cascade copied from `defaultThreadEnvMode`: global `settings.json` → repo `pathway.json` key (`packages/contracts/src/pathwayProjectFile.ts`) → per-project DB column (migration mirroring `039_ProjectionProjectsDefaultThreadEnvMode.ts` + the ProjectionProjects service/projector trail). UI shows inherited-source label (precedent: `ProjectSettingsPanel.tsx:495, :882-922`).
- Settings UI: new `SettingsRow` with Select on `/settings/source-control` (copy `SourceControlWritingSettings.tsx:72-115`), registered in `settingsSearch.ts`.
- Behavior:
  - `core_git`: current (fixed) pipeline — thread branch, repeated actions push to it, existing PR grows; UI downgrades to "Commit & push" when a PR exists.
  - `graphite`: "Commit, push & PR" creates the next branch in the stack (based on the current branch, not main), commits, then `gt` submits the stack (`gt create` / `gt submit --stack`); each press = one new stack entry (explicit, predictable). A `GraphiteCli` wrapper modeled on `GitHubCli.ts` (via `VcsProcess`) with auth/presence probe; if `gt` is missing or unauthenticated, the action fails fast with an instructive message and a link to Graphite setup — no silent fallback.
  - `GitManager.runStackedAction`'s pr/branch steps consume the resolved mode (precedent for settings reaching this layer: writing-style at `GitManager.ts:625`).
  - Sidebar/History render stack relationships (branch badges showing stack parent) when in graphite mode — read from `gt` metadata refs if cheap, else branch-base config.

---

## Delivery order

1. **M1 — Read surfaces**: log/showChangeSet + enriched status + listRemotes RPC → History view + real sidebar (read-only). No mutations, immediately demo-able.
2. **M2 — Working Copy**: index ops + hunk apply → staging UI + commit composer.
3. **M3 — Branch/remote management**: remaining remote ops, upstream picker, branch rename/delete, context menus.
4. **M4 — Graph mutations**: cherry-pick/merge/rebase/revert/reset + sequence state + conflict UI + drag-and-drop.
5. **M5 — Stashes.**
6. **M6 — Workflow modes**: setting + Graphite integration.

Each milestone is independently shippable; capability gating keeps partial states coherent.

## Tests

- Driver ops: integration tests against scratch repos (follow `.plans/git-flows-integration-tests.md` harness) — status partitions, hunk apply round-trip, cherry-pick conflict → continue/abort, remote add/set-url, upstream tracking, log pagination stability across new commits.
- Contracts: decode/default tests beside existing settings tests; patch-struct coverage for `sourceControlWorkflow`.
- UI logic: pure-logic files (`*.logic.ts`) for lane-graph layout (deterministic fixtures), staged/unstaged partitioning, drop-intent resolution.
- E2E: test-pathway-app flow — seed a repo, stage a hunk, commit, view history, cherry-pick between branches, verify conflict banner.

## Acceptance criteria

- A repo with no `origin` remote works identically to one with `origin` everywhere in the new surfaces.
- Every destructive verb has a checkpoint-backed undo path.
- jj-detected repos show the new UI gated to supported capabilities without errors.
- With workflow mode `graphite` and `gt` absent, the publish action fails with an instructive, non-generic message; with `gt` present, three consecutive "Commit, push & PR" presses yield a 3-PR stack, each PR based on the previous branch.
- With `core_git`, N consecutive publishes on one thread never error and never create a duplicate PR.
