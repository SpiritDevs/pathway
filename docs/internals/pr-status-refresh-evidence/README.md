# PR status refresh verification

The thread's Version Control panel previously retained an unqualified “Merge conflicts” warning after a failed refresh. The server could also return a stale detail response while refreshing its cache in the background, leaving the next client read to collect the update.

PR details now use the existing 15-second cache directly: an expired entry waits for its replacement, and concurrent readers share the request. An explicit refresh invalidates the PR reference before re-reading the shared client atom. The thread refreshes on navigation/window return, successful push completion, and agent turn completion, with the existing 30-second observer handling changes elsewhere. The compact row uses its parent's detail query, qualifies pending/unknown/error states, and offers Refresh/Retry.

The `PullRequestService.detail` span records the project, repository, PR number, returned state and mergeability, cache age, and cache TTL. It records no conversation content or credentials.

## Evidence

- [Before: retained conflict after failed refresh](before.png)
- [Checking after a turn/push](checking.png)
- [After: resolved conflict](after.png)
- [Failure with Retry](failed.png)
- [Recording](refresh-states.webm)
- [Scenario results](results.json)

The browser used the real thread PR component, refresh hook, atom implementation, and UI controls with a controlled synthetic host. The baseline used the previous production row. Eight updated-behavior scenarios passed with no page errors, including automatic recovery on the next poll after failure. Long timer intervals were advanced with the browser's clock; delayed responses were released explicitly.

This was an isolated component integration, not a signed-in full-app test. No Clerk development credentials were configured on this machine. No live database or installed app was modified. Disposable fixture code remains in the worktree's ignored `.pathway/pr-status-evidence` directory.

Focused automated coverage includes server cache expiry, concurrent readers, invalidation, unknown state and failure recovery; shared-client refresh ordering/coalescing and passive observers; and rendered checking/error/conflict/merge states.

## Surfaces

- Web and desktop share the changed thread row, including its hover-card use. Push triggers observe the common VCS action state, so toolbar, palette and keybinding entry points use the same path.
- Agent turn completion is provider-independent. Codex, Claude, Cursor, Grok and OpenCode all use the thread's latest-run completion state.
- Server detail behavior applies to every VCS provider and every client. Native iOS continues using its existing PR-detail RPC and already requires mergeable status before enabling Merge; no native UI change is required for this compact web-row defect.
- Environment IDs and PR references scope requests through the existing local/remote/relay transport. No wire schema changed.
- Failed checks retain the existing PR title but do not present the previous conflict or merge action as verified. Retry and subsequent successful polling restore the normal controls.
