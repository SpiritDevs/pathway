# Native Issues implementation

The native SwiftUI Issues client uses the existing company bootstrap/change subscription owned by
`PathwayCloudModel`. `PathwayIssuesModel` projects issue-domain entities only when their versions
change. It does not create a second company subscription or invalidate the issue list for every
agent-thread update.

Company-owned writes go through `sync:applyOperations`, with the actual membership, replica
version, installation ID, and operation sequence. Uncertain operations retain their IDs for retry.
Environment-only calls use Pathway Connect and an explicitly selected company/project binding.
The shared RPC client gates issue calls on the current socket's issue protocol acknowledgement.
Reconnection requires a fresh acknowledgement. Detail observation caches live investigation and
comment-agent state while cloud sync remains authoritative for durable issue content.

Comment actions use replicated role and role-assignment grants, including company ownership,
own-comment permissions, moderation, and team scopes. Concurrent issue edits retain individual
optimistic patches so rejecting one write does not discard another; replica confirmation retires
only the matching writes.

## Entry points and clients

- Compact shell and regular-width sidebar route to the same native Issues list.
- Existing issues are pushed navigation destinations, including links from planning and related
  issues. Each destination retains its own tab and comment/checklist drafts. Native Back pops the
  destination. New issues and property editing remain sheets owned by the current screen.
- Detail has separate Details, Comments, Attachments, Sub-issues, AI, and Activity tabs. AI controls
  push another destination. A navigation preference hides the compact app dock until returning
  to the list.
- Issue detail, creation, planning, settings, and bulk actions are reachable from the list menu.
- Web and Electron retain their existing UI and use the same backend contracts. No wire schema or
  provider adapter changed.
- The native app uses the configured provider/model catalog. Running work uses the existing native
  thread creation path, including attachment persistence before the initial message.
- visionOS retains its existing cloud-transport limitation. The legacy `apps/mobile` directory has
  no application sources in this checkout; this implementation is in `apps/pathway-ios`.

## Verification

Focused native tests cover company isolation, detail projection, rejected and uncertain writes,
operation identity, socket handshake renewal, filter/date semantics, saved-view configuration,
manual ordering, and image namespaces.

Debug builds accept `--uitest-issues` to open an isolated deterministic workspace. This uses the real
SwiftUI list/editor/detail and shell with a local receipt transport. It has no Clerk, Convex, or relay
connection, uses separate defaults, and is excluded from Release and visionOS builds. UI tests use
it to check visible row density, creation/editing, search, secondary controls, related-issue history,
contextual property changes, and drag reordering across statuses without mutating a real workspace.

The final focused run on 5 September 2026 passed 46 native unit tests and three UI tests
(board drag, list drag, and compact list/editing). Separate UI runs also passed creation, search and
secondary controls, related-issue history, and long-press status changes.

The iPhone 17 Pro simulator pass confirmed at least 11 hittable issue rows,
list and board reordering, cross-status drops, and the saved status after reopening an issue.
Long-press checks confirmed status, priority, assignee, and due-date actions; changing status and
unassigning an issue updated the list. Ordering uses native List insertion offsets across a flattened
header/issue collection, while board drops use the same ordering resolver. Explicit High/Normal/Low
priority remains a separate property.

Screenshots and Xcode result exports are retained locally under
`.pathway/evidence/issues-ios-2026-09-05/`.

Simulator fixture evidence proves layout and local interaction only. It does not prove production
authentication, cloud mutation acceptance, relay execution, Slack delivery, or provider output.

### Dedicated issue navigation verification

The follow-up simulator pass verified six focused UI flows after converting existing issues to
navigation destinations: compact list/editing, creation, issue tabs and AI subview, parent/child
Back navigation with an unsent comment draft, list drag with return navigation, and search/planning.
All passed. Screenshots are in `navigation-screen/` under the local evidence directory above.
The AI control navigation was checked with the disconnected fixture; executing agent work still
requires connected-environment verification.
