# Move a thread to a worktree

Status: accepted and implemented, 2026-09-01

## Intent

Add an icon button beside the active project folder in the Agent Thread details panel. The action moves an existing thread from the project's root checkout into a new Git worktree without losing the checkout's uncommitted changes.

The user describes the operation as:

1. Stash the root checkout's changes.
2. Create a worktree for the thread.
3. Apply those changes in the worktree.
4. Continue the same thread in that worktree.

## Current model

- A project owns the root checkout path.
- A thread stores an optional `worktreePath` and branch.
- A started thread with a worktree is currently treated as workspace-locked in the client.
- Changing a thread's `worktreePath` detaches its provider sessions so the next turn can start in the new directory.
- The existing VCS worktree command creates a worktree. It does not transfer dirty state or update the thread.
- Git worktrees share one repository. The operation creates a linked checkout, not a second clone.

## Proposed terms

**Workspace move**
The complete operation that transfers a thread and its dirty state from the root checkout to a new linked worktree.

**Source checkout**
The checkout currently assigned to the thread before the move. The first version is expected to support only the project's root checkout.

**Target worktree**
The new linked checkout created for the thread.

**Transfer stash**
A temporary Git stash created solely to carry tracked and untracked changes from the source checkout to the target worktree. It is not durable thread state.

## Invariants

- A workspace move starts only while the thread has no active or queued work.
- A workspace move also waits until every other thread using the source checkout has no active or queued work.
- A successful move leaves the source checkout clean and the target worktree holding every tracked and untracked change that was present in the source.
- The thread changes workspace only after the target worktree exists and accepts the transfer stash.
- A failed move must not lose changes. The source checkout or the transfer stash must retain them.
- A transfer conflict does not rebind the thread to a conflicted target.
- The transfer must not consume or apply an unrelated user stash.
- Git-ignored files remain in the source checkout and are not added to the transfer stash.
- The target runs the same configured worktree setup action as any other Pathway-created worktree.
- The command must detect a raced workspace change before rebinding the thread.
- The server owns the workflow because the repository and provider process live in the selected environment, including remote and tunnel connections.
- A retry must reconcile an earlier partial attempt instead of creating another branch or worktree.
- Client disconnect does not cancel an accepted move or its rollback.

## Implemented workflow

1. Validate that the thread still points at the expected root checkout and that the repository can move.
2. Create a uniquely identifiable transfer stash that includes untracked files.
3. Resolve the source checkout's exact `HEAD` and create a temporary branch and linked worktree from it.
4. Apply the exact transfer stash by object id in the target worktree.
5. Atomically rebind the thread's branch and `worktreePath`, which detaches the old provider session.
6. Drop the transfer stash only after the thread rebind succeeds.
7. Start the project's standard worktree setup action.
8. Refresh source and target Git status.
9. Attempt to rename the temporary branch through the standard semantic branch-naming path.

## Deferred work

- Moving a thread back to the project folder needs a separate design because the shared checkout
  may have changed since the move. It is deliberately outside this version.
- Native mobile UI is deferred while the Agent Thread interface is being rebuilt.

## Grill decisions

### Idle-only move [locked]

The action is enabled only when the thread has no active or queued work. Pathway does not interrupt a turn to move it. While work is active, the button stays visible but disabled and its tooltip explains why the move cannot start yet.

### Checkout-wide dirty state [locked]

The move transfers every tracked and untracked change in the source checkout. Pathway does not infer which files belong to the active thread. The confirmation identifies this as a checkout-wide move and shows the number of affected files.

### Ignored files and setup action [locked]

Git-ignored files stay in the source checkout. The transfer stash includes untracked files but excludes ignored files. After Pathway creates the target worktree, it invokes the same configured worktree setup action used by normal worktree creation. There is no move-specific setup path.

### Automatic branch naming [locked]

The button does not ask for a branch name. Pathway creates the worktree immediately with a collision-resistant temporary `pathway/<id>` branch, then uses the existing branch-name generation and rename path to derive a semantic name from the thread title. A naming or rename failure leaves the valid temporary branch in place and does not fail the move.

### Exact source base [locked]

The target branch starts from the source checkout's exact `HEAD`. The workspace move does not honor the "new worktrees start from origin" preference. Local commits remain part of the moved workspace, and the transfer stash applies to the same commit it was created from.

### Transfer conflict rollback [locked]

If the transfer stash does not apply cleanly, Pathway does not attach the thread to the conflicted target. It force-removes the incomplete worktree and its temporary branch, then reapplies the exact stash to the source checkout. If source restoration also fails, Pathway leaves the transfer stash intact and reports its object identifier with recovery instructions. It never drops the stash until either the target move or source rollback is confirmed.

### Shared-checkout activity gate [locked]

Pathway blocks the move while any thread using the source checkout has active or queued work. This includes the target thread and other threads in the same checkout. Idle threads may remain attached to the source and do not block the operation.

### Terminal gate with explicit stop [locked]

Running terminal sessions rooted in the source checkout block the transfer. Pathway presents a clear blocking dialog with the terminal count and an explicit `Stop terminals and move` action. That action stops every affected terminal, waits for their cleanup receipts, rechecks all workspace-move guards, and only then starts the transfer. Pathway does not silently stop terminals when the user presses the workspace icon.

### Setup failure is recoverable [locked]

The move commits before Pathway starts the configured worktree setup action. Failure to start the action does not roll the workspace back. Pathway keeps the thread attached to the target, shows the setup failure, and offers `Run setup again` through the existing project-action path.

### Durable server workflow [locked]

After confirmation, the owning server persists and runs the workspace move independently of the initiating client. A panel close, route change, WebSocket loss, relay interruption, or client shutdown does not cancel it. Clients reconnect to authoritative progress or the final success, rollback, or manual-recovery result. Repeating the same command id reconciles the existing attempt.

### Confirmation and progress [locked]

The project-folder row has an icon button with the tooltip `Move thread to a worktree`. Clicking it always opens a confirmation dialog before Git changes. The dialog shows the tracked and untracked file count, says that every checkout change will move, and says that ignored files remain in the source. Its primary action is `Move to worktree`, or `Stop terminals and move` when affected terminals are running. During the durable operation, the UI renders discrete persisted phases such as `Saving changes`, `Creating worktree`, `Applying changes`, `Moving thread`, and `Starting setup`. It does not use a continuously repainting progress animation.

### Web and desktop first [locked]

The shared React client ships the project-folder-row action for web and desktop. Native mobile is deferred while its Agent Thread UI is under construction. The contracts and server workflow remain client-neutral so mobile can add the same action later without a backend redesign.

### Command palette, no keybinding [locked]

`Move thread to a worktree` appears in the command palette when the active thread can use it. It opens the same confirmation flow as the project-folder-row icon. The action has no default keybinding and adds no Settings preference.

## Surface checklist

- Entry points: thread details panel and command palette ship; Settings and keybindings do not apply.
- Clients: web and desktop share the React UI. Native mobile is explicitly deferred.
- Providers: the move changes the provider's working directory, so all provider sessions must detach and resume consistently.
- Contracts: this needs one server-owned workspace-move command with typed progress and failures, not a client sequence of Git calls.
- Reverse states: moving back to the root checkout was explicitly deferred to a separate design.
- Connection modes: the command runs on the owning environment and must survive relay or tunnel disconnects.
- Docs: the final behavior belongs in `docs/user/`; the architectural decision belongs in `docs/adr/`.
