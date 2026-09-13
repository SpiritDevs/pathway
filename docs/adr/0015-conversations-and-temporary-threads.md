# Conversations and temporary threads

Status: Draft, product interview in progress. No feature implementation authorized.

Date: 2026-09-08

## Requested behavior

A conversation is a thread without an attached project. It appears in the normal thread list with a chat icon and the label "Conversation". It follows the normal thread lifecycle and settlement timing. A user can attach it to a project later.

Temporary status is independent of project attachment. Both a project thread and a conversation can be temporary. Temporary can be selected until the first message is sent. After that, an existing thread cannot be made temporary, including a thread previously made permanent through Keep conversation. A temporary thread is automatically deleted when it settles, with cleanup of its worktree and related resources.

Temporary threads skip inactivity settlement. They can be settled manually or automatically after a merged PR. Uncommitted changes or unpushed commits block automatic settlement. Manual settling with unfinished Git work opens a popup offering **Review changes**, **Cancel**, and **Discard and delete**. Committing alone does not resolve unpushed work. A temporary projectless conversation's files outside Git are deleted without an extra warning.

Attaching a project preserves the same thread and history. Files already in the conversation folder stay there. The thread retains references to both its conversation folder and its project workspace, and the agent must be told that it can access and use both. Project attachment does not itself remove temporary status. For the first version, attachment is allowed only when no work is running or queued and only to a project on the same environment.

Temporary project threads always get a new dedicated worktree. This applies both when starting on a project and when attaching a project to an existing temporary conversation. A shared checkout is not an allowed fallback. The original conversation folder remains available alongside the new worktree.

Before settlement, **Keep conversation** can make a temporary thread permanent. This changes retention without moving its files or dropping either directory reference. Its conversation folder remains subject to normal thread deletion and cleanup.

Projectless conversations appear in All by default. Focus configuration gains a Conversations checkbox alongside the project choices, allowing projectless conversations to appear in selected Focuses. Once attached, a thread follows its project's Focus. Whether multiple Focuses can enable the checkbox at once remains under discussion.

The temporary control belongs in the upper-right area described by Corey. The supplied screenshot also points to the bottom of the project picker. Exact placement of the Conversation option and Temporary control needs confirmation.

## Model under discussion

| Project attachment | Retention | Requested behavior                                                                  |
| ------------------ | --------- | ----------------------------------------------------------------------------------- |
| None               | Normal    | Conversation, retained after settlement, attachable later                           |
| Project            | Normal    | Existing project thread behavior                                                    |
| None               | Temporary | Conversation, deleted on settlement                                                 |
| Project            | Temporary | Dedicated worktree, deleted on settlement; retains any original conversation folder |

An environment owns execution and thread history. Each projectless conversation gets its own working folder beneath that environment's Pathway userdata directory, where the agent can use tools and create files. The folder is removed when its owning thread is deleted or removed through normal thread cleanup. A normal retained conversation keeps its folder after settlement. This folder is not itself a filesystem security boundary.

The exact directory layout, defaults, company scope, and Focus checkbox exclusivity remain unresolved. Implementation must use the environment's configured userdata root, including isolated development homes, rather than a hard-coded path to the maintainer's live install.

## Local source findings

These findings describe the current checkout, which was 55 commits behind origin/main at the start of this interview. Recheck against the implementation branch before choosing migrations or editing runtime code.

- Both `packages/contracts/src/orchestration.ts` and `packages/contracts/src/orchestrationV2.ts` require `projectId` when creating a thread. Projectless conversations require a contract and ownership decision, beyond adding a picker item.
- `packages/client-runtime/src/state/threadSettled.ts` derives effective settlement from explicit overrides, merged change requests, and the configured inactivity window. It keeps pending approvals, pending input, and active or queued execution from appearing settled. An unmerged change request blocks inactivity settlement.
- `apps/server/src/orchestration-v2/Orchestrator.ts` implements settle-after-completion with run, runtime-request, and background-work checks. A completed response alone is insufficient for that workflow.
- That orchestrator's delete transition records `deletedAt`. This alone is not evidence that history, provider sessions, files, and other resources have been physically erased.
- `apps/web/src/worktreeCleanup.ts` identifies an orphaned worktree only when no other listed thread shares the path. Automatic cleanup needs authoritative ownership checks on the environment.
- `docs/adr/0001-focus-is-an-agent-threads-filter.md` describes current Focus membership as exclusive per project, with active-company filtering applied first. The proposed Conversations checkbox needs an explicit membership and company-scope rule because conversations have no project from which to derive either.

## Interview queue

### First decisions, answered

1. Projectless conversations can use tools and create files in their own folder under Pathway userdata. Thread deletion and normal thread cleanup must remove that folder.
2. Uncommitted changes or unpushed commits stop automatic settlement of temporary threads. Manual settling warns and lets the user inspect or commit the work before deleting it. The second answers below specify the popup actions and discard policy.

### Second decisions, answered

1. Yes: temporary threads skip inactivity settlement and settle only manually or after a merged PR, with automatic settlement blocked by uncommitted changes or unpushed commits. Merely attaching a PR does not trigger deletion.
2. Yes: the manual warning offers Review changes, Cancel, and Discard and delete. Committing alone does not resolve unpushed work. Discard and delete is an explicit user choice.
3. No extra warning for files outside Git in a temporary projectless conversation's folder. Those files are deleted when the thread is settled.

### Third decisions, answered

1. Keep files in the conversation folder when attaching a project. Preserve the same thread and history, retain references to both directories, and explicitly make both available to the agent.
2. Yes: offer Keep conversation before settlement. Attaching a project leaves temporary status unchanged.
3. Always create a new dedicated worktree for temporary project threads, including temporary conversations that acquire a project later.

### Fourth decisions, answered

1. Yes: project attachment is restricted to the same environment and to when no work is running or queued.
2. Default to All. Add a Conversations checkbox to Focus configuration alongside normal projects so projectless conversations can appear in selected Focuses. After attachment, follow the project's Focus.
3. Yes: Temporary can be selected until the first message is sent. Keep conversation remains available afterward, with no way to make the existing thread temporary again.

### Fifth decisions, asked

1. Can several Focuses enable Conversations independently, or is Conversations restricted to one Focus like existing project assignments?
2. Are projectless conversations personal and visible across company selections, or assigned to the company selected at creation? This is a visibility and ownership question, not a proposal to change who can access an environment.
3. Should temporary threads retain the explicit Settle after completion action, keeping the thread for review if a run fails or Git work remains unfinished, or require settlement after work finishes?

### Project attachment

- Preserve the accepted thread history and both directory references when resuming the provider after attachment. Verify provider capabilities before choosing a session transition.
- Can an attached conversation be detached again or moved to another project?
- Resolve the fifth-round Focus and company questions. Specify project filters and defaults without a project, while preserving environment access rules.
- Should Conversation be a persistent entry beside New project in the pictured picker, and should it ever become the default for the next new thread?

### Temporary lifecycle

- Specify bulk settling and resolve the fifth-round settle-after-completion question under the accepted manual-settlement policy. Default-branch pushes alone do not qualify for automatic deletion under the accepted manual-or-merged-PR rule.
- Temporary can be selected until the first message. Keep conversation is accepted; its exact placement remains open.
- Specify the retained thread's normal worktree lifecycle after Keep conversation.
- Temporary project threads require a new dedicated worktree. Define ownership of the local branch and both working directories for cleanup, including any later forks.
- Define behavior when the selected project cannot create a Git worktree. Do not silently use its shared directory.
- How should pinning, snoozing, archiving, failed runs, and pending input affect temporary retention?
- Should deletion be immediate and irreversible, or have an undo period? What should the client show if the deleted thread is open?
- What exactly is deleted: visible history, durable events, attachments, checkpoints, browser captures, provider session files, child threads, scratch files, worktree, and local branch? External work such as pushed branches or published artifacts needs a separate explicit policy.
- What happens after a restart or while clients are disconnected? What should users see if cleanup fails, and how should retry work?
- Do forks and side chats inherit temporary status, and how should shared resource ownership work?

### Delivery and verification

- Confirm coverage for web, Electron desktop, native Apple clients, and any other maintained mobile client. Inventory actual clients before implementation.
- Review all creation entry points, thread menus, command palette actions, and keybindings.
- Make a capability decision for Codex, Claude, Cursor, Grok, and OpenCode, including resuming history after project attachment.
- Verify local, remote/relay, and tunnel behavior with environment-owned lifecycle operations.
- Add focused backend coverage for creation restrictions, attachment, settlement races, cleanup ownership, and recovery. Add focused client coverage for controls and visibility.
- Browser or computer-use verification requires Corey's explicit authorization. No browser was launched for this interview.

## Decision log

### 2026-09-08, first answers

- Accepted: a dedicated working folder per conversation beneath the owning environment's Pathway userdata, with files and normal agent tools supported.
- Accepted: remove that folder when its thread is deleted or removed by normal cleanup. No folders were created in the live install during this interview.
- Accepted direction: prevent automatic settlement from deleting uncommitted changes or unpushed commits. Manual settlement presents a warning and a route to inspect or commit the changes.
- The initial questions about inactivity, PR triggers, explicit discard, and files outside Git were resolved in the second answers below. Final warning body copy remains open.

### 2026-09-08, second answers

- Accepted: temporary threads skip inactivity settlement. Manual settlement or a merged PR can trigger deletion, subject to the unfinished-Git-work checks.
- Accepted: manual settlement with unfinished Git work offers Review changes, Cancel, and Discard and delete.
- Accepted: delete files outside Git in a temporary conversation folder without another warning.
- The questions about attachment files, keeping threads, and dedicated workspaces were resolved in the third answers below.

### 2026-09-08, third answers

- Accepted: preserve conversation files in their original folder after project attachment. Maintain both directory references and make their availability explicit to the agent.
- Accepted: Keep conversation makes a temporary thread permanent before settlement. Project attachment itself preserves temporary status.
- Accepted: temporary project threads require a newly created dedicated worktree, both at initial creation and when a project is attached later.
- The attachment restrictions, basic Focus visibility, and Temporary creation boundary were resolved in the fourth answers below.

### 2026-09-08, fourth answers

- Accepted: attach only to a project on the same environment and only while no work is running or queued.
- Accepted: projectless conversations appear in All by default. A Conversations checkbox alongside the project choices includes them in selected Focuses. Attached threads follow their project's Focus.
- Accepted: first-message submission locks out enabling Temporary. Keep conversation is available afterward, and a kept thread cannot become temporary again.
- Pending: Focus checkbox exclusivity, company scope, and explicit settle-after-completion behavior.

The original brief and answered decisions are requirements. Recommendations and unanswered questions are not approved defaults.
