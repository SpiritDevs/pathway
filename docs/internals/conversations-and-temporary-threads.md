# Conversation ownership and temporary retention

An environment owns thread execution and history. A V2 thread with `projectId: null` is a conversation;
`conversationCompanyId` records the company selected at creation. Cloud publication requires that
explicit company and environment authorization. Attachment makes project bindings authoritative for
visibility. No synthetic project record is created.

`conversationPath` is separate from `worktreePath`. The environment creates it below its configured
userdata root, including isolated development homes. Attachment preserves it and the native provider
thread identity, releases the old runtime, and resumes with the new working directory. Runtime policy
grants the retained folder and provider turns describe both directories. This folder is not a sandbox.

| Provider | Attachment support                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------- |
| Codex    | Resume the native thread with the retained folder included in writable roots.                       |
| Claude   | Resume with additional directory access; fork lookup includes the original session location.        |
| Cursor   | Resume the native session with both directories in the SDK's local working-directory configuration. |
| Grok     | Load the existing ACP session at the new working directory with both allowed roots.                 |
| OpenCode | Resume the session and update its directory permissions to include the retained folder.             |

The provider receives directory context without rewriting accepted user messages in durable history.

Projectless MCP thread operations scope list, read, and control access by the parent conversation's
company. New app-owned threads inherit that company from the authenticated parent scope.

`temporary` controls retention independently of project attachment. The environment provisions a
dedicated worktree for temporary project threads and records `ownedWorktreePath` and `ownedBranch`.
An atomic ownership record makes interrupted provisioning recoverable without adopting an unrelated
checkout. Shared kept worktrees retain their ownership metadata until the final referencing thread is deleted.
Keeping a thread changes retention without moving files or dropping ownership. An explicit Keep
operation records `keptAt`; ordinary first-message acceptance independently locks out enabling Temporary.

The server validates attachment, first-message restrictions, active work, and Git state. Client
settlement derivation does not classify temporary threads by inactivity or a cached merged PR.
The environment reconciles temporary settlement at startup and once per minute, including while
clients are disconnected. A merged PR is verified through the Git workflow; explicit settle-after-
completion is checked again under the thread command lock. Unverified Git state leaves the thread retained.
Pinned threads reject merged-PR settlement; archived threads are retained. Snooze changes visibility only.
Git checks cover repositories created inside the conversation folder without treating an enclosing
development checkout as conversation work. Bounded discovery fails closed when verification cannot finish.

Deletion uses normal thread deletion semantics and durable cleanup effects. Cleanup verifies live and
archived thread references before removing shared resources and only deletes recorded owned local
branches. Workspace cleanup waits for provider and terminal shutdown dependencies. Failed deletion
cleanup uses durable retries with capped backoff, including after process loss. Environment subscriptions
report named cleanup failures and allow an authorized client to request an immediate retry. This is not a promise to erase
the event store, provider-native session files, remote branches, or published artifacts.

Explicit parent deletion cascades through app-owned subagent descendants even after Keep changes
retention. Active subagent work still blocks deletion; ordinary settlement of a kept parent retains its history.

Focus definitions have an independent `includeConversations` flag. Company scope applies first;
project attachment restores ordinary project membership. New client controls require the environment's
`threadConversations` capability so older environments retain their existing behavior.

Maintained surfaces in this checkout are web, Electron (the web client), and the shared SwiftUI app
for iPhone, iPad, and visionOS. There is no React Native or Android app in this checkout.
