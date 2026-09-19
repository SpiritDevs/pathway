# Report a bug

Status: approved design implemented in this worktree. Focused automated verification passed; no deployment or manual client walkthrough has been performed.

## Requested behavior

- Let a user report a Pathway bug from their phone.
- Create a new task in the Pathway project for each submitted report.
- Include phone logs and diagnostic data with the report.
- Offer a switch to start an agent investigation that adds context and research.
- Show a model picker only while investigation is enabled.
- Use the supplied native bug-report sheet as the visual reference.

## Codebase findings before implementation

The current mobile application is native SwiftUI in `apps/pathway-ios`, with shared iPhone, iPad, and visionOS screens. Its README excludes Android from the current release.

Tasks are the existing tracked work items. Their routes, contracts, and many source names still use `issue` for compatibility. A bug report should create a task through the existing task model. See [task terminology](../internals/tasks-terminology.md).

The existing task investigation accepts an `issueId` and chooses a model from environment settings. It reads the task description, comments, and supported image attachments, then posts findings. A per-report model choice needs a per-run override. See `packages/contracts/src/issues.ts`, `apps/server/src/issues/`, and `PathwayIssueSettingsView.swift` for the reusable model picker.

Cloud task attachments currently accept images and MP4/WebM videos. Diagnostic files would need explicit support in `packages/backend/convex/issueAttachments.ts` and in the investigation input. Attaching a file alone does not make its contents available to the investigating agent.

The phone has a bounded, persisted login-error reporter in `PathwayLoginErrorReporter.swift`, but no general app log archive or shake handler was found. The login reporter provides a retry pattern; its narrow anonymous endpoint is separate from authenticated task submission.

Task creation uses signed-in cloud sync and does not require an online execution environment. Investigation requires an environment with the destination project's checkout. Its existing run model includes progress, cancellation, and findings comments.

The existing investigation can also update priority and missing task fields. The report flow must preserve the agreed research scope. Provider restrictions differ: Codex uses a read-only sandbox, Claude uses plan permissions, and OpenCode denies permissions. Cursor and Grok need particular care because equivalent enforcement was not established during source inspection. Do not describe a prompt instruction as a sandbox guarantee.

## Design tree

Accepted in the first round:

1. Start in the Apple app. Add a Settings entry and shake-to-report on iPhone, with a setting to disable the gesture. Shared Apple screens expose the Settings entry.
2. Include recent Pathway logs, app and device versions, connection failures, and current screen/task identifiers automatically, with credentials removed. Screenshots and conversation contents are optional attachments.
3. Investigation defaults off. When enabled, the agent reads code and diagnostics, attempts reproduction where possible, and posts findings to the task. Code fixes require a separate action. Show the model picker only while investigation is enabled.
4. The first version serves the team reporting into its existing Pathway project, using existing destination access. A public maintainer intake flow is outside this version.

Accepted in the second round:

5. Remember a destination company/project selected in Settings, show it on the report form, and use that project's connected environment and model subscription for investigation.
6. Require one "What went wrong?" description, derive the task title from it, and offer optional screenshot/chat attachments with review before submission.
7. Save the task even if investigation cannot start. Offer a later investigation start/retry; do not queue an automatic start when the environment returns. If Cloud is unavailable, preserve the report draft for retry without creating duplicate tasks.

## Confirmed final details

The maintainer accepted these details and authorized implementation in the final design check.

- Shake detection starts enabled on iPhone and can be disabled in the report sheet or Settings. It only opens the form; it never submits a report. Ignore repeated shakes while the form is open. The preference belongs to the device.
- Configure the destination explicitly and remember it for the signed-in account. Do not infer the destination from a project name. Missing or revoked project access preserves the draft and asks the user to choose an accessible destination.
- Capture the diagnostic snapshot when the report opens. Keep a bounded recent log history, covering up to the preceding 15 minutes of this app session with event and byte limits. Record the available time range and any truncation. Do not promise logs from before collection began or from other apps.
- Collect app/build and OS/device versions, Pathway connection and request failures, and current screen, environment, project, task, and thread identifiers when available. Exclude credentials and raw request/response bodies from automatic logging. Collection must not cause continuous UI updates or transmit logs until the report is submitted.
- Screenshot and chat inclusion start off. An optional screenshot captures the app screen before the report sheet appears; allow an existing screenshot to be attached instead. Optional chat content comes from the current thread, with a bounded, reviewable export that states any truncation. Missing context does not block the report.
- Store the diagnostic snapshot with the task as a file, with a readable summary in the task description. Make its content available to investigation explicitly; do not rely on the existing description/comment truncation limits. Optional chat content follows the same attachment approach.
- Investigation starts off for each new report. When enabled, preselect the environment's configured investigation model and allow an override for this report. Do not change the environment-wide model setting. An unavailable environment or model leaves reporting usable and explains that investigation must be started later.
- Save the task and diagnostic evidence before starting investigation. If an upload fails after task creation, show that the task exists and retry the missing upload against the same task. Preserve the draft and submission identity through app restarts and retry uncertain writes before considering another create operation.
- After success, show the task key and an "Open task" action while preserving the screen the user was on. The task exposes investigation progress, findings, stop, and later start/retry using the existing run controls. Findings are comments; proposed priority or metadata changes remain suggestions for bug-report investigations.
- Keep the existing task access and delete/restore behavior. Unsaved report drafts can be discarded, and attachment choices can be removed before submission. Turning off investigation before submission hides the picker; stopping an already-running investigation happens from the task.

## Implementation outline

- Add a native report coordinator, retained draft, diagnostic collector, and sheet. Connect Settings and the iPhone shake event to the same flow. Reuse the existing task model and model picker.
- Extend the shared attachment contracts, cloud attachment validation, and client rendering for diagnostic text/JSON files. Ensure web and desktop can open evidence attached by the phone, even though report creation starts in the Apple app.
- Extend task investigation with an optional per-run model override and support for the report's diagnostic context. Existing callers keep their current default behavior. Preserve the comments-only scope for bug-report investigations.
- Keep creation and attachment upload on the authenticated Cloud task path. Use the project's existing environment routing for investigation across local, remote, relay, and tunnel connections.

## Verification plan

- Focus native tests on credential removal, bounded capture, durable draft recovery, duplicate-safe submission, and task-saved/upload-failed or investigation-unavailable states.
- Add focused contract, attachment, and investigation tests for supported diagnostic files, model overrides, evidence inclusion, and comments-only findings.
- Check the native builds affected by shared Apple screens, plus scoped TypeScript checks for changed packages. No repository-wide checks.
- Browser and simulator UI interaction require the maintainer's separate request or agreement under `AGENTS.md`. Document whether an integrated client pass was performed.
- After implementation, document the shipped reporting behavior in `docs/user/` and update this plan's status.

## Documentation

Agreed terms are recorded in [the project glossary](../internals/glossary.md), the vocabulary location specified by `AGENTS.md`. Usage is documented in [Report a bug](../user/report-a-bug.md). The implementation reuses task creation, attachment storage, and investigation; no separate ADR was needed.

## Implementation and verification

The native report retains a stable task identity, evidence comment identity, and upload request identities across retries. A confirmed access rejection unlocks the destination; an uncertain response retains the original pending operation. Task creation includes the destination project's teams and workflow team. Drafts and selected attachments are stored under the signed-in account's local directory.

The collector keeps at most 500 events from the previous 15 minutes and caps diagnostic JSON at 256 KiB. It records operation names, outcomes, error domains and codes, with screen and device context captured when the form opens. It does not copy raw request payloads or error descriptions. Optional conversation exports include at most 50 recent messages and 60,000 characters.

Investigation RPCs accept a company/project route and an optional model override. The environment checks the authenticated account and active checkout binding, synchronizes the report before starting, and reads authorized diagnostic attachments. Diagnostic text bypasses ordinary comment truncation. Bug-report findings are posted as comments without applying suggested task metadata changes.

| Area                       | Result                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native tests               | 20 passed: report recovery, upload retry, access rejection, project team scope, diagnostic bounds, investigation failure, and existing task data behavior.     |
| TypeScript tests           | 288 passed across the six focused contract, replica routing, investigation, evidence, and cloud sync/attachment test files.                                    |
| TypeScript checks          | Server, backend, and web checks passed. Existing Effect suggestions remain.                                                                                    |
| Targeted lint              | No errors; two existing warnings in backend files remain.                                                                                                      |
| Apple builds               | iPhone test build, iPad simulator build, and visionOS simulator build passed. The visionOS build retained the existing empty camera usage-description warning. |
| Integrated UI verification | Not performed. Browser and simulator UI interaction require a separate request or agreement under `AGENTS.md`.                                                 |

Surface review:

- Entry points: Settings on iPhone, iPad, and visionOS; shake on iPhone with a device preference. A command-palette action or keyboard shortcut is outside the agreed initial scope.
- Clients: Apple creates reports. Web and Electron render diagnostic attachments as file links. Android reporting is outside this release.
- Providers: Codex, Claude, Cursor, Grok, and OpenCode reuse their existing investigation adapters. Unsupported images are explicitly reported as omitted. Provider permission differences described above still apply.
- Contracts: Optional routing and per-run model selection preserve existing RPC callers. Cloud permits bounded JSON and plain-text attachments.
- Reverse states: Close and resume, discard a draft, remove optional attachments before submission, retry missing evidence, and use the task's existing investigation start/stop controls.
- Connections: Task creation uses Cloud independently of environment availability. Investigation uses the project's existing environment connection and active checkout binding. Routing tests cover account, environment, project, and revoked-binding checks; no live relay/tunnel walkthrough was performed.

Release the updated Cloud attachment endpoint and environment server support with the Apple client. This work did not deploy either service.
