# Conversations and temporary threads

Status: Implementation in progress. Product interview complete; implementation authorized.

Date: 2026-09-08

## Decision

Project attachment and retention are independent choices.

| Project attachment | Retention | Behavior                                                           |
| ------------------ | --------- | ------------------------------------------------------------------ |
| None               | Normal    | Personal conversation, retained after settlement, attachable later |
| Project            | Normal    | Existing project thread lifecycle                                  |
| None               | Temporary | Personal conversation, deleted when it settles                     |
| Project            | Temporary | Dedicated worktree, deleted when it settles                        |

A conversation has `projectId: null`. It is a normal thread with a chat icon and the label Conversation, without a synthetic project record. The owning environment allocates a working folder beneath its configured Pathway userdata. Agents can use tools and create files there. Thread deletion and normal thread cleanup remove the folder. Normal settlement retains it.

Conversations belong to their creator and remain visible across company selections. They appear in All by default. Any number of Focuses can independently enable a Conversations checkbox alongside their project choices. The same conversation can appear in each selected Focus. Attaching a project makes the thread follow the project's Focus.

Owners can share a conversation with users in companies they belong to. Each recipient receives either Can view or Can collaborate access. Company membership alone does not grant access to personal conversations. Sharing and relay discovery must enforce those grants on the server, including after revocation.

## Attaching a project

Attachment keeps the same thread identity and history. The original conversation folder and its contents stay in place. Subsequent work uses the project workspace, and the agent receives explicit references to both directories.

Attachment is allowed only while no work is running or queued, and only to a project on the same environment. A temporary conversation receives a new dedicated project worktree. A permanent conversation uses the project workspace. Attaching a project leaves temporary status unchanged.

The first version supports one attachment transition from a projectless conversation. Detaching or repeatedly moving an established thread between projects is outside this change. Existing guarded replacement of an interrupted initial project thread remains separate.

## Temporary retention

Temporary is selected on a new draft before its first message is sent. After sending, an existing thread cannot become temporary. Keep conversation makes it permanent, preserves files and history, and cannot be reversed into temporary status.

The Temporary control appears in the upper-right thread header. The badge remains visible after creation; Keep conversation is available from the badge and thread action menu. Conversation is an entry beside New project in the project picker, and New conversation is available in the command palette. With no available project, new-thread entry points can create a conversation on the selected environment.

Temporary threads skip inactivity settlement and default-branch push settlement. The accepted deletion triggers are:

- Manual Settle.
- A linked PR being merged, subject to unfinished-work checks.
- An explicit Settle after completion request, once work succeeds and finishes.

A failed run, active or queued work, pending requests, uncommitted changes, or unpushed commits prevent automatic deletion. Merely linking a PR does not trigger deletion. Automatic settlement is owned by the environment so it continues without an open client.

When manual settlement finds unfinished Git work, the dialog offers Review changes, Cancel, and Discard and delete. Review changes opens the changes panel and keeps the conversation. Discard and delete explicitly authorizes discarding the unfinished work. Committing alone does not resolve unpushed commits. Files outside Git in a projectless conversation folder do not receive a separate warning.

Temporary project threads always require a new dedicated worktree, including attachment of an existing temporary conversation. Failure to create that worktree must retain the thread or draft for recovery; execution must not fall back to a shared checkout. Keep conversation retains the worktree under the normal thread lifecycle.

Deletion removes the thread from normal navigation and cleans up its owned local resources. Cleanup must preserve directories used by other threads, unrelated directories, and externally published work. It must be retryable after interruption. This feature does not promise erasure of provider-owned history or external services. Pinning, snoozing, and archiving do not convert a temporary thread into a permanent one. Keep conversation is the explicit retention action.

## Implementation boundaries

- V2 thread, shell, and creation contracts carry nullable project ownership, temporary status, and the original conversation directory.
- Server commands enforce attachment, retention, cleanup, ownership, and sharing. Clients cannot bypass those rules by submitting different workspace paths.
- Draft state persists the creation choice. Shared client lifecycle helpers keep temporary threads visible until the server has accepted settlement.
- Web and Electron share the new controls. Native clients require corresponding contract and presentation support.
- Provider adapters must retain conversation history while changing the working directory and must expose both directories after attachment.
- Local, remote, relay, and tunnel connections use the environment's configured userdata path. No client supplies the maintainer's home path.

## Verification

Use focused tests for draft persistence, attachment, worktree ownership, settlement blockers, cleanup recovery, company and Focus visibility, and recipient permissions. Check all thread entry points and lifecycle actions, including the command palette, keyboard actions, related chats, and bulk actions.

Browser or computer-use verification requires Corey's explicit authorization. No browser verification is claimed by this record.

## Interview record

Corey approved the working folder location and cleanup, manual and merged-PR settlement policy, unfinished-work warning actions, no extra warning for non-Git scratch files, preserving both directories after attachment, Keep conversation, dedicated temporary worktrees, idle same-environment attachment, independent Conversations checkboxes across Focuses, personal company-independent visibility, per-recipient sharing permissions, and explicit settle-after-completion with retention on failure or unfinished work.
