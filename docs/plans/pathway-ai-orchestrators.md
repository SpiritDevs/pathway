# Pathway AI orchestrators

Status: product decisions and visual direction agreed. This document records the maintainer's brief, accepted interview answers, and selected UI concepts. Implementation is in progress.

## Requested behavior

- System and project orchestrators act as personal assistants and project managers, coordinating and delegating work rather than writing code themselves.
- Coordination spans tasks, agent threads, time tracking, connected mail, and other platform capabilities.
- A dedicated settings area controls the selected model, defaulting to GPT-6 Astra with high reasoning. Model choices form a sortable fallback list with drag reordering and per-choice reasoning effort and supported performance options.
- Orchestrators can react independently to events, including finished threads and incoming mail, and initiate messages when the user should know something.
- Long-term memory retains user-provided information and preferences, including forms of address, the orchestrator's name, persona, and communication style.
- A Messages-style interface presents orchestrators as persistent contacts, with ongoing DMs and named group chats for projects or events. The navigation entry opens a floating chat with a top-left switcher, expandable into a full Messages-style inbox on web/desktop. Mobile uses a full-screen conversation list. Chats and unread state are shared across these views.
- Orchestrators can message each other and retrieve relevant conversation or compacted context to understand the other orchestrator's work.

## Design tree

Settled in the first round:

1. A private personal PA spans the user's accessible companies, projects, and environments. Project orchestrators can be explicitly shared.
2. Orchestrators have full autonomy within configured roles and privileges, managed on a permissions page in orchestrator settings, similarly to a user. The earlier recommendation to require confirmation by action category was not accepted as the general default.
3. Coordination spans environments: discover threads and capabilities, share context, delegate Git/file work, monitor resources and availability, and redirect work when appropriate.
4. Personal communication preferences are shared; personal memory and project knowledge have separate boundaries. The user can explicitly request information or preferences apply to all orchestrators.
5. An orchestrator is a persistent contact, independent of any one chat. Users have an ongoing DM and can create group chats with multiple orchestrators for a project or event. Individual tasks do not require new user conversations. Delegated work retains separate linked agent threads.

Settled in the second round (the maintainer accepted all recommendations for Q6–Q13):

6. Orchestrator chats and memory are cloud-owned. Reasoning runs on an eligible environment with automatic host handover. If none are online, messages queue; this design does not commit Pathway to providing a hosted model runtime.
7. Unstarted work can be redirected immediately. Running work transfers only after establishing the original execution stopped and recovering its changes. A disconnected environment may still be executing. Independent work continues while the orchestrator explains any blocked transfer.
8. Permission settings distinguish who can direct an orchestrator from what it can do. Authorized directors can assign work within its role even if their own action permissions differ. Other participants can contribute information. Delegation preserves the originating assignment's limits.
9. Group chats support both human and orchestrator participants. New participants receive existing group history by default, with an option to share only from joining. Membership grants no access to separate DMs or private memory.
10. Each group has one lead, initially selected by its creator. The lead owns unaddressed requests, delegates, and consolidates updates. Users can directly address other participants or change the lead.
11. Memory can be written automatically and inspected, corrected, deleted, and scoped by the user. Explicit instructions override inferred preferences; observations retain their sources. Applying memory to all of a user's orchestrators requires a separate visibility confirmation if it would expose private information to teammates.
12. Blockers, decisions, and urgent developments generate immediate messages. Routine completions are batched. Chat retains progress while notification settings control OS alerts.
13. Floating and expanded web/desktop views and the full-screen mobile experience share chats and unread state.

Settled in the third round:

14. Model fallback choices are configurable in a sortable list. Each choice exposes its reasoning effort and other supported performance options. Provider allowance visibility and allowance-based work controls must also be available to ordinary agents across Pathway; see the [allowance design](pathway-provider-allowance-budgets.md).
15. Start with a configurable limit of four active delegated assignments per orchestrator, subject to environment capacity and project conflicts. Excess work uses the same queuing mechanism as ordinary threads, presented appropriately in a messaging interface.
16. Orchestrators can initiate useful work within standing responsibilities. A project orchestrator remains limited to its own project unless brought into a collaboration. A coordinating orchestrator can create a group with project A and project B orchestrators, which exchange project context and coordinate dependencies. Each orchestrator delegates implementation to agent threads and subagents.
17. Use summaries first and obtain further authorized details as needed, including by asking the responsible project orchestrator to prepare a context response. Preserve orchestrator chat history through compaction, while delegated thread history remains environment-owned. Expose unavailable or outdated context.
18. Pause stops new autonomous activity while existing assignments continue. Stop work cancels queued assignments and requests interruption of running work, exposing unconfirmed stops. Archive pauses the orchestrator and removes it from active contacts while retaining history. Delete separately removes the identity and retained memory with explicit handling of shared chats and outstanding work. Resume and unarchive restore active states. The interface remains a Messages-style communication experience.
19. Management permission is separate from direction authority. Owners manage personal orchestrators; designated managers manage shared ones. Permission changes apply to subsequent actions and delegated work. An orchestrator may propose permission changes but cannot grant itself additional authority.
20. Forgetting a memory prevents its automatic relearning from retained history. Corrections supersede old values. Source-message deletion and memory deletion are separate actions with clear explanations.
21. Start with one ready-to-configure personal PA. New orchestrators can have project or custom responsibilities. Settings cover identity/persona, model/fallback, eligible environments, responsibilities, permissions, memory, notifications, and work limits. Project orchestrators inherit defaults with visible overrides.

Settled in the fourth round:

22. Allowance budgets use percentage points of the full selected provider quota window. The example takes an account from 60% remaining to 50%; 10% is illustrative, not a default allocation.
23. All observed account consumption counts conservatively toward the guard. The assignment's coordinator, threads, and subagents share it across environments. A fallback account needs its own configured budget.
24. Stop new dispatches as the threshold approaches and request interruption of managed active turns at the observed threshold, preserving partial work. Pause allowance-controlled work when reliable readings are unavailable. Delayed readings and in-flight requests can cause overshoot; an exact provider-side cutoff is not promised.
25. Wait for the user unless automatic resumption is explicitly specified. Scheduled resumption uses the user's selected timezone and an explicit allowance allocation. Provider quota resets do not automatically renew authorization.
26. A cross-project invitation authorized for the participating projects grants relevant project-context access for the collaboration. Each project's orchestrator retains responsibility for dispatching work in its own project; requests for work in another project go through that project's coordinator.

## Cross-project coordination scenario

The user asks for a feature spanning a server project and an iOS project. A coordinating orchestrator starts a group including itself and both project orchestrators. The iOS orchestrator asks the server orchestrator for the API contract and relevant implementation context. The server orchestrator prepares a context response, and each project orchestrator delegates its implementation work to its own agent threads and subagents. Either can identify a dependency in the other's project and message its coordinator to request work. The group lead consolidates progress for the user.

The invitation must be authorized for both projects and grants relevant project-context access for this collaboration. The iOS coordinator requests server changes through the server coordinator; neither gains independent dispatch authority over the other's project. Separate DMs, personal memory, and private mail retain their existing visibility boundaries.

## Design status

All questions raised in the product interview are answered. The maintainer reviewed seven UI concepts and selected Floating Companion for floating mode and Chat + Work for the full view, explicitly requiring light and dark themes. Review the [selected references](../internals/orchestrator-ui-concepts/README.md) and [comparison gallery](../internals/orchestrator-ui-concepts/index.html). Engineering details such as ownership fencing, event receipts, provider capability enforcement, quota freshness thresholds, and storage schemas remain implementation work; they must preserve the decisions above.

## Selected visual direction

- **Floating mode: Floating Companion (concept 02).** An elevated chat panel sits over the current Pathway view. Its top-left conversation switcher selects DMs/groups; expand and minimize controls sit in the header. Messages, delegated-work attachments, and the composer remain inside the panel.
- **Full view: Chat + Work (concept 03).** Follow the existing agent-thread workspace: conversation sidebar on the left, messages in the centre, and a conversation metadata panel on the right. Keep the main conversation visually dominant and the overall treatment minimal.
- **Metadata panel:** support the existing Pathway pattern for inline or floating placement. It contains participants, related/delegated work, relevant environments, and conversation controls. Reuse the existing shell behavior and components where suitable; exact panel docking and width should follow those conventions rather than create an unrelated layout system.
- **Both light and dark themes:** cover the entire surface, including the surrounding shell, floating panel, switcher, composer, attachments, metadata, menus, empty/offline states, and settings. Use existing theme tokens and preserve consistent interactions, readable contrast, and status distinctions.
- **Shared conversation:** floating/full transitions retain the selected chat, draft, history position, and unread state. Themes change appearance without changing layout or behavior.
- **Responsive clients:** use the selected structure on web/desktop. Mobile retains the agreed full-screen conversation list/chat and exposes metadata through an appropriate native panel.

The original seven images are exploratory references. Concepts 01, 04, 05, 06, and 07 are not selected replacements for the main layouts. In particular, dark mode must follow the selected layouts rather than substitute the separate Midnight Messages concept. Application implementation should adapt the selected visual treatment to Pathway's existing navigation and panel conventions.

## Implementation sequence

This is the proposed engineering sequence for the full agreed scope, not a reduction to a chat-only release.

1. Define cloud-owned identities, chats, participants, group leads, memory, roles, direction/management permissions, and collaboration grants. Add shared contracts and authorization checks. Keep ordinary delegated threads environment-owned.
2. Add coordinator execution using existing provider/delegation machinery, with enforced coordination-only tools, eligible-host selection, ordered model choices, durable event delivery, and handover. Establish one authorized execution owner before enabling automatic failover; disconnected hosts must not retain authority to issue duplicate actions.
3. Integrate tasks, thread lifecycle, time tracking, connected mail, environment/resource discovery, and scheduled responsibilities. Add cross-project requests and sourced context responses, delegation queues, completion receipts, and group-lead consolidation. Gate each operation with the assigned capability, including delegated mail access and sending.
4. Implement the shared [provider allowance controls](pathway-provider-allowance-budgets.md), including agent-visible tools, backend monitoring, cross-environment guards, and durable pause/resume.
5. Build the shared client state, Messages-style chat surfaces, settings, contact/group creation, memory controls, lifecycle controls, and proactive notifications. Provide the same behavior on web, desktop, and mobile.
6. Verify the integrated scenarios below, update shipped-product documentation when behavior exists, and complete focused checks for the changed scope. Browser and computer-use verification require the maintainer's explicit authorization under AGENTS.md.

Each dependency can be implemented and tested incrementally. No step alone completes the agreed feature.

## Acceptance criteria

- A user can configure their personal PA, create a project/custom orchestrator, and use a persistent DM or group across devices. Starting a task does not require a new chat.
- The navigation entry opens Floating Companion on web/desktop; expanding it shows the selected Chat + Work layout with left conversations, central messages, and right inline/floating metadata. Mobile provides a full-screen list and chat. All views share participants, history, queues, and unread state, and mode transitions preserve drafts and history position.
- Both selected modes and their menus, controls, metadata panels, and settings are verified in light and dark themes using existing Pathway theme behavior.
- Settings default to GPT-6 Astra/high and expose a reorderable fallback list with supported options per choice. Unsupported model/effort combinations and unavailable providers have honest states. Runtime fallback respects configured choices and allowance allocations.
- Orchestrators autonomously perform authorized coordination and delegate coding/Git/file changes. Provider policies must enforce this separation; a prompt alone is insufficient proof. Every provider adapter receives an explicit support decision before exposure as a coordinator choice.
- The server/iOS example completes through two project coordinators and their delegated work, with sourced context, explicit dependency ownership, and one consolidated user update. Collaboration does not expand dispatch privileges.
- Orchestrators react to relevant mail, task, thread, schedule, and environment events while clients are closed. Routine completions are batched; urgent/blocking messages follow existing notification policy without duplicate thread alerts.
- When a host goes offline, chats and memory remain available in cloud state. Unstarted work can be redirected. Running work is not duplicated, and unconfirmed execution or unrecovered local changes remain visible blockers. With no eligible host online, messages queue.
- Long histories compact without deleting chat messages or losing active assignments. Memory supports source tracking, scope changes, correction, and forgetting without automatic relearning from retained history.
- Role and management changes govern subsequent actions and descendants. Group history sharing, private memory, mail ownership, and project-context access follow the agreed boundaries.
- Pause/resume, stop, archive/unarchive, and delete have distinct behavior. Queued/running work and shared history receive explicit handling, including unconfirmed interruption on offline hosts.
- Allowance limits work for ordinary agents as well as orchestrators and meet the separate allowance acceptance criteria.

## Surface and verification coverage

| Area           | Application to this design                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Entry points   | Navigation icon, floating/expanded chat, settings, and relevant existing command/keybinding entry points use the same feature state.                                                                              |
| Clients        | Web and Electron desktop share web UI where appropriate; mobile implements the corresponding native interface. Shared state belongs in client-runtime.                                                            |
| Providers      | Codex, Claude, Cursor, Grok, and OpenCode need capability decisions for coordinator execution, worker delegation, context, and allowance telemetry. Missing telemetry remains unsupported rather than fabricated. |
| Contracts      | Cloud/server/client state, tool requests, receipts, permissions, and lifecycle transitions use shared typed contracts.                                                                                            |
| Reverse states | Resume, unarchive, cancel queued work, remove participants, revoke grants, and edit/forget memory are included alongside creation and activation.                                                                 |
| Connections    | Local, remote/relay, and tunnel connections; multiple clients/environments; reconnects and all-hosts-offline behavior.                                                                                            |
| Performance    | Paginate history, retrieve context on demand, subscribe to bounded state, and react to events. Avoid transcript replication on broad feeds and continuous visual animation.                                       |
| Docs           | Design/architecture records remain in internals/plans/ADRs. User documentation describes shipped behavior when implemented.                                                                                       |

Backend verification should use focused tests for authorization, ownership, delivery/recovery, budgets, context, and lifecycle behavior, synchronized with typed receipts and worker drains. UI verification should include group/DM navigation, settings reordering, queue and offline states, and memory actions. Repo-wide checks are not required by this plan.

## Existing implementation constraints

- The current Orchestrator view is an activity dashboard, not a persistent AI identity. Existing delegation and durable child-completion machinery can inform the new design.
- Current thread MCP access is scoped to the caller's project. A personal orchestrator spanning projects needs an explicit authorization model.
- [Durable thread submission](../internals/durable-thread-queue.md) keeps full conversation history and execution on environments. Cloud stores queued intent and discovery metadata. A disconnected environment may still be executing accepted work; accepted work is not currently movable through this queue.
- [Connected mail](../internals/connected-mail.md) is private to its owner membership. Current mail analysis has tools disabled and sending requires a user Send action. Autonomous mail management therefore needs an explicit delegated capability, not just a new prompt.
- [Notification policy](../adr/0030-cloud-snapshots-alert-eligibility-and-clients-deliver.md) already distinguishes cloud attention history from client alert delivery. Proactive chat messages should account for that separation.
- The provider model manifest recognizes `gpt-6-astra`, but an environment's advertised provider models and reasoning options determine actual availability. A configured default is not proof an account can run it.
- There is no existing cross-provider coordinator-only execution mode. Content-only invocations remove delegation tools too; ordinary read-only modes do not establish a policy that permits Pathway coordination while denying direct coding. Provider-specific enforceable capabilities are required.
- Existing usage distinguishes context occupancy, cumulative tokens, account quota, and reported or API-equivalent cost. API-equivalent cost is not actual subscription spending. Coordinator concurrency and usage controls would be new behavior.
- Existing thread reads are paginated, and durable context transfers and handoff summaries retain provenance. These provide accessible history and summaries, not unrestricted access to another provider's complete internal context.

## Existing vocabulary

Use **task** for Pathway's tracked work, following the [glossary](../internals/glossary.md). “Issue” remains appropriate for an external tracker item or an actual defect. The user-facing AI orchestrator must be distinguished from the existing server orchestration engine.

## Interview record

Round one: the maintainer accepted personal/shared ownership and scoped memory, selected full autonomy controlled through roles and privileges, required cross-environment coordination, and expanded the chat model to persistent contacts plus DMs and group chats. The latest supplied image establishes the intended Messages-style conversation list, message bubbles, participant identity, and inline action presentation; individual illustrated integrations are not additional requirements.

Round two: the maintainer accepted all recommendations for Q6–Q13. Those answers are recorded above without changing the first-round autonomy requirement.

Round three: the maintainer accepted Q15 and Q18–Q21, specified sortable fallbacks with per-choice reasoning effort for Q14, extended allowance controls to all Pathway agents, and clarified Q16–Q17 with cross-project collaboration and context requests. Project boundaries apply until an orchestrator is brought into a collaboration.

Round four: the maintainer clarified Q22 as percentage points of the full quota, explicitly noting 10% was only an example, and accepted Q23–Q26. This settles the product questions raised by the interview.

Visual review: after comparing seven generated mockups, the maintainer selected concept 02 for floating mode and concept 03 for the full view. They emphasized both light and dark themes and consistency with existing agent threads: left conversations, central messages, and right floating/inline conversation metadata.

Architecture decisions:

- [Orchestrator identity is separate from chats](../adr/0034-orchestrators-are-identities-independent-of-chats.md).
- [Cloud owns orchestrator continuity; environments execute](../adr/0035-cloud-owns-orchestrator-continuity.md).
- [Direction authority is distinct from action privileges](../adr/0036-orchestrator-direction-and-action-permissions.md).
- [Allowance budgets use observed account consumption](../adr/0037-allowance-budgets-use-observed-account-consumption.md).

The product interview and visual selection are complete. Implementation is in progress.

### Implementation progress

- Shared contracts and cloud storage for orchestrator identities, settings, continuing chats, messages, memory, and queued coordination jobs are implemented.
- Authenticated CRUD, direction/management separation, revision checks, message idempotency, queue cancellation, paginated history, membership revocation, and memory corrections have focused backend tests.
- Web/desktop components for the full chat view, floating companion, conversation sidebar, details panel, and nine settings pages are implemented. The pages live under the existing Settings sidebar's Orchestrators group, with search and breadcrumbs. The companion is mounted above page content, has a persistent rail launcher, command-palette entries, and a configurable shortcut.
- Signed-in web verification uses the existing approved hostname, routed only within an isolated Chromium profile to the worktree preview. Clerk uses the authorized production identity configuration; feature data remains on an isolated local Convex deployment. No new public hostname or production deployment is required. Real-app screenshots are recorded in the [UI evidence directory](../internals/orchestrator-ui-evidence/README.md).
- Coordinator reasoning uses tool-free provider execution with renewable, generation-fenced cloud claims. Cloud decisions recheck live identity and capabilities. Delegated work enters the existing durable environment-command queue, with assignment limits, permission checks at dispatch, and distinct cancellation versus unconfirmed interruption. Focused tests cover these paths and sourced memory exclusions.
- Real coordinator reasoning, delegated worker execution, final-result reporting, and inherited Pathway tool permissions have passed signed-in checks. Group membership and history controls are implemented. Completion notifications and their browser delivery/click flow are verified. Priority connected-mail analysis now queues a private Chief update with live mailbox permission checks; its integrated provider check is pending.
- Provider allowance guards now persist in Cloud and supervise coordinator and worker execution, including local, remote, scheduled, and provider-native descendants. Manual pause/resume passed in the actual app. Native Messages, main Settings integration, and allowance controls pass syntax parsing; Xcode build and simulator checks await the reinstall.
- Project-free PA delegation, sourced numeric allowance instructions, one-time scheduled allocations, and retained-worker continuation after allowance renewal are implemented. Project scope, current-human instruction, stale continuation, and missed-schedule boundaries have focused tests. The live group exchange completes through all three contacts; project-free PA telemetry and a one-time scheduled allocation have passed live checks after fixing parent-repository checkpoint discovery. A second live worker successfully read Time Tracker through the new PA tools.
- Connected mail and Time Tracker now expose delegated PA tools, preserving owner, private audience, current capabilities, and queued-send revocation. Standing responsibility reviews have a configurable cloud cadence and bounded recent issue/thread/environment context, including host resources sampled only when reasoning work is claimed. Specific work can be stopped; provably unaccepted work can be atomically redirected to another environment.
- Manual task changes, ordinary thread completions, and environment offline/recovery transitions now queue bounded, coalesced, permission-checked reviews. Shared sourced preferences are visible across private contacts, including their Memory settings. Stop controls revoke existing assignment authority even after a root worker has replied and the contact later resumes.
- Mobile background notifications use the relay's existing APNs registrations and delivery receipts, with account, unread, membership, expiry, and delivery-time access checks. Foreground notifications share sequence deduplication with the mobile push path. Focused tests exercise delivery policy and revocation; physical-device delivery remains unverified.
- A live running worker was interrupted through its allowance, resumed automatically on the same thread after explicit renewal, and checked retained progress before completing. All verification allocations were removed afterward.
- The two-project scenario passed a live read-only check: Server and iOS each delegated exactly one worker in their own isolated project, exchanged sourced contract information, and received a consolidated Chief update. Both workers completed with clean repositories. This verifies documentation compatibility and coordination, not runtime API behavior. Shared personal memory was also edited and forgotten through another private contact's actual Settings page.
- Background and peer reviews may complete quietly when no user-facing update is useful. Direct human messages still require a response. Coordinator replies render Markdown inside the Messages-style bubbles on web and native clients.
- Remaining verification includes the provider-driven recurring responsibility cadence, native SDK/simulator and physical-device push checks, and production remote/tunnel rollout. Native checks await Xcode. Changes to an existing allowance use the explicit Settings controls; conversational allocation can add a guard but cannot relax one. Worker-created remote work or detached schedules must be routed back through the coordinator. This preview has not been deployed or released.
