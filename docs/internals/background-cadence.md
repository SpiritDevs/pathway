# Server background cadence

The desktop server shares a laptop with the renderer. Every process spawn and
trace line costs the user typing latency, so timers that spawn processes follow
the rules below. If you add a timer, give it the same shape: fast only while
something is changing or someone just asked, slow or silent otherwise.

## VCS remote status pollers

`VcsStatusBroadcaster` runs one remote poller per subscribed worktree (all
`subscribeVcsStatus` streams for the same real path share it). A tick only runs
while `BackgroundPolicy` reports a foreground client lease for that worktree.

- The poller refreshes on the configured interval (30 s by default, or the
  automatic git fetch interval).
- After 4 refreshes in a row with an unchanged remote status, the delay doubles
  per refresh, up to 5 minutes. A configured interval longer than that still
  wins.
- A new subscriber on a slowed poller resets the count and refreshes at once,
  so opening a thread shows fresh ahead/behind and PR state.
- Any change in the cached remote status resets the count, including changes
  published by explicit refreshes and git actions.
- Failures use the separate failure backoff (30 s doubling to 15 min).

## Repository detection

`VcsDriverRegistry.detect` caches positive results for 5 minutes, including
the `.pathway/vcs.json` kind override. Negative results are never cached, so
`git init` is picked up immediately. A cached hit whose cwd no longer exists is
re-detected, so removed worktrees stop routing to git.

## Terminal subprocess inspection

`TerminalManager` inspects every running terminal from one process-table read
per tick (`ps -Ao pid=,ppid=,comm=`, or one PowerShell query on Windows). It no
longer runs one read per terminal.

- Ticks run every second while any terminal has a child process, or had input
  or a spawn in the last 10 seconds.
- Idle shells get one sweep every 10 seconds.
- Inspector injection in tests takes the whole PID batch and returns a map
  keyed by terminal PID.

## Project enrichment

Repository identity and favicon results are cached for 10 minutes. Project
mutations invalidate them explicitly; the TTL only catches out-of-band edits.

## Time tracking summaries

The summarizer has no timer of its own. Each publisher reconcile wakes it after
run lifecycle events and on the 15 second heartbeat. The summarizer then drains
every summary that is ready.

## Trace volume

The local trace file drops fast, successful child spans. Helpers that only
duplicate their parent's lifetime, such as per-stream output collection in
`processRunner`, use `Effect.fnUntraced` instead of emitting a span.

## Client polls that reach the server

Browser timers that trigger server work skip their ticks while the window is
hidden. The next visible tick or return-to-window refresh catches up.

- Focused-thread pull request detail (`pullRequests.detail`, which runs `gh`)
  refreshes every 60 s, and only while the window is visible and focused.
  Returning to the window or thread refreshes it at most once per 30 s.
- The storage indicator reads `server.getHostResources` every 2 minutes. The
  server re-samples storage once a minute, and each read spawns `vm_stat` on
  macOS.
- An open conversation refreshes its storage snapshot every 60 s, or every
  2 s while a cleanup job runs.
- The command palette renders at most 30 thread matches. Each thread row
  mounts its own git status and pull request reads.

## Desktop main process

The Electron main process follows the same rules. Renderers get changes pushed
over `webContents.send`; they do not poll the main process.

- Update checks run 15 seconds after launch and then every 4 minutes. They
  slow to every 30 minutes once an update is available or downloaded. After
  failures they back off exponentially from 8 minutes up to 1 hour. Background
  polls never publish the `checking` state, so the sidebar pill stays still.
- The local backend topology (`getLocalEnvironmentBootstraps`) is read over sync
  IPC once per window load and cached in the preload. After that, main compares
  it every 2 seconds, in process and untraced, and pushes it on
  `desktop:local-environment-bootstraps` only when it changes.
- Connection catalog saves skip the encrypt-and-replace when the plaintext
  matches the last write.
- Pending snapshots are listed only when a capture becomes ready, on window
  focus or visibility, and when the editor closes. They are never listed on
  re-renders.
