# Agent sidebar navigation investigation

Investigated September 12, 2026, at `48abbfe1e`. Scope: returning to Agent Threads from other sections, including Provider Settings. The findings below describe the original behavior. The fixes and verification are recorded next.

## Implemented fixes

- PR classification now lives in a small account/company-scoped atom cache instead of component state. Idle scopes expire after 30 minutes; ready shell snapshots prune removed threads. This retains grouping across navigation without keeping rows or VCS subscriptions mounted. Source matching still invalidates branch, project, worktree and attachment changes. Refresh errors do not replace a known classification with an unknown one.
- Unclassified PR-dependent threads wait behind a loading status. Temporary observers fetch only the information needed to classify them, then unmount. If an initial PR check fails without any cached classification, the thread remains reachable in Active; subsequent failures retain an already known classification. Explicit lifecycle choices, pins, queued/running work and rows without a PR source do not wait unnecessarily. Known rows can render while other rows load.
- Partitioning uses an environment's advertised descriptor when its live configuration is not yet available. Truly unknown capabilities wait; a loaded older descriptor with omitted capabilities still means unsupported. Unsupported servers retain active rows and existing action gating.
- Company ownership bootstrap, initial environment shells and selected Focus assignments now contribute explicit readiness. Loading and failure messages replace misleading empty-state messages. Ownership filtering remains authoritative: this change never restores rows from an old company's snapshot during reauthorization.
- A Focus subscription restart for the same account retains the last complete view. Account/deployment changes, disabling and runtime teardown clear it. A selected Focus is not temporarily replaced by All while its projects load.
- Removed whole-list `autoAnimate`. The first 20 rendered rows also skip `content-visibility` placeholders: browser traces exposed an additional 100px-to-82px initial row-height correction. Later rows retain the offscreen rendering optimization, and drag-and-drop keeps its existing transitions.

Verification uses the production sidebar with synthetic external data, as in the original investigation. Warm navigation, delayed PR refresh and delayed live config all retain four visible rows and **Settled (106)** from the first sampled returning frame, with zero list animations. Cold PR/config/shell inputs show a loading message and then the correct grouping, without displaying 110 active rows. The mixed cold-PR case keeps four known rows at the same heights and positions while the remaining PR statuses arrive. Reduced-motion checks remain stable.

All 201 tests in nine focused files passed. The regression suite covers classification cache retention/expiry and account/company isolation, changed PR sources, explicit overrides, queued work, snooze wake/pin restoration, PR reopening, failed refreshes, company readiness, selected Focus readiness and subscription cleanup. The web typecheck, targeted lint and formatting checks passed. All nine browser scenarios completed without page or console errors. No server, transport, provider adapter or native-client change is required for this React sidebar defect.

After-change evidence: [browser recording](agent-sidebar-navigation-evidence/sidebar-navigation-after.webm), [returning sidebar](agent-sidebar-navigation-evidence/after-ready.png), and [frame traces](agent-sidebar-navigation-evidence/after-frame-traces.json). The authenticated full-app limitation below still applies; the verification does not claim a packaged Electron or live remote-environment test.

## Original investigation

The oversized list has a confirmed source-level cause: settlement classification depends on state owned by the sidebar's mounted rows. Leaving the section discards the parent’s PR-status map. Returning first classifies threads without that information, then reclassifies them as rows report their PR status. An additional capability-loading branch can temporarily expose even explicitly settled threads.

The blank panel was also reproduced in a browser using the production sidebar: the correct four rows existed but were animated at opacity zero. With warm data, disabling animation through reduced motion removed the blank interval. Normal navigation to Provider Settings does **not** inherently unsubscribe the shared thread list in this revision.

The browser fixture uses synthetic data and the actual `Sidebar` component, with a placeholder for the Settings section. It establishes both failure mechanisms without reproducing the user's signed-in cloud session or proving the exact timing of the supplied screenshots. The documented Clerk development credentials and test configuration were absent on this machine, so no authenticated full-app pass was possible.

Evidence: [scenario recording](agent-sidebar-navigation-evidence/sidebar-navigation-scenarios.webm), [blank frame](agent-sidebar-navigation-evidence/warm-blank.png), [same four threads after animation](agent-sidebar-navigation-evidence/warm-ready.png), and [per-frame traces](agent-sidebar-navigation-evidence/frame-traces.json).

## Browser reproduction

The fixture supplies 110 synthetic thread shells, of which 106 have merged PRs and four should stay active. It renders the production sidebar, replaces it with a static Settings placeholder, and then remounts it, matching the conditional branch used by the app layout. The router and sidebar provider remain mounted during this transition. It substitutes the external data inputs and never connects to a real environment, provider or cloud account. The initial attempt to render the real Settings navigation required Clerk context; the final recording uses the placeholder to isolate the sidebar lifecycle without an authentication error boundary remounting its ancestors.

| Controlled scenario                          | Observed behavior                                                                                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Warm data, animations enabled                | The first sampled returning frame already had four rows and “Settled (106)”, but all four row opacities were `0`. The first sample with visible rows was about 175 ms later. |
| Same warm return, reduced motion             | Four visible rows and “Settled (106)” in the first returning frame; zero animations.                                                                                         |
| PR results withheld for 500 ms after remount | 110 rows appeared before returning to four. The collapse reached 114 concurrent animations and kept removed rows in the DOM during their exit animations.                    |
| Same PR delay, reduced motion                | 110 rows still appeared before switching to four. This separates the classification defect from animation.                                                                   |
| Config withheld for 500 ms after remount     | The list likewise expanded to 110 before returning to four when capabilities arrived.                                                                                        |
| Shell list withheld for 500 ms after remount | A real empty state occurred, followed by animated insertion and reclassification of the restored rows.                                                                       |

These are development-build, headless Chromium measurements. The injected 500 ms delays are experimental inputs, not measured production latency. The final warm animated run's first returning frame was at 160 ms after capture began and the first visibly populated frame at 334 ms; the approximately 175 ms interval is the **observed sampled blank interval**, not a universal duration. Per-frame visibility checks use bounding-box intersection and opacity above 0.05, supplemented by screenshots and video; they are not pixel-perfect occlusion tests.

## Findings

### 1. Returning rebuilds settlement from an empty component-local PR map

**Confirmed by source, helper probes and the production-component browser fixture.**

- [AppSidebarLayout.tsx](../../apps/web/src/components/AppSidebarLayout.tsx) conditionally replaces `ThreadSidebar` with Settings, Projects, Email, Calendar, Orchestrator, Issues, or Source Control navigation. Desktop-width dashboard and other sidebar-free pages remove it as well.
- [Sidebar.tsx](../../apps/web/src/components/Sidebar.tsx), around line 2321, initializes `changeRequestStateByKey` with `useState(() => new Map())`. This map survives row removal, but not sidebar removal.
- Its partition, around line 2529, calls `currentThreadChangeRequestState` with this map. [threadPullRequest.ts](../../apps/web/src/state/threadPullRequest.ts), line 98, returns `null` when the map has no matching entry.
- [threadSettled.ts](../../packages/client-runtime/src/state/threadSettled.ts) requires a known merged PR for PR-based automatic settlement. An unresolved attached PR explicitly blocks inactivity-based settlement. Recent branch-associated threads also remain active without the merged result.
- Each mounted row reads VCS status and attached PR details, then reports the aggregate state through a **React effect** in `Sidebar.tsx`, around line 1067. Only then does the parent repartition.

The sequence is:

```text
Correct active/Settled partition
  → navigate to Provider Settings
  → sidebar and its PR map unmount
  → return; map starts empty
  → PR-auto-settled historical threads enter Active
  → rows report cached or fetched PR status
  → historical rows move back to Settled
```

This does not require a server to change any thread. Even a warm PR query cache does not populate the parent's empty map during its initial render. Whether the incorrect commit is visibly painted depends on effect scheduling and rendering cost.

A temporary probe using the production settlement and PR-cache helpers reproduced `settled → active → settled` for an unchanged thread. With 106 synthetic historical threads it produced active counts `0 → 106 → 0` solely by dropping and restoring cached classification. This is a deterministic logic reproduction, not a measured browser recording or a claim about the exact 106 threads in the screenshot.

### 2. “Capabilities unknown” is treated as “settlement unsupported”

**Confirmed by source and controlled capability delay in the browser fixture; occurrence during the user's particular navigation is unmeasured.**

The partition in `Sidebar.tsx`, around line 2516, only evaluates settlement when:

```ts
serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSettlement === true;
```

An absent config therefore puts an otherwise settled thread into Active. Snooze has the same shape. This includes threads with an explicit `settledOverride: "settled"`; the correct settlement helper is never called for them until the config is available.

[server.ts](../../apps/web/src/state/server.ts) assembles configs separately from thread shells. [session.ts](../../packages/client-runtime/src/state/session.ts) starts initial config observation with `Option.none()`. Server config projections and VCS subscriptions have five-minute idle retention, while PR queries also have cache lifetimes. See [server.ts](../../packages/client-runtime/src/state/server.ts), [runtime.ts](../../packages/client-runtime/src/state/runtime.ts), and [vcs.ts](../../packages/client-runtime/src/state/vcs.ts).

This is particularly relevant to newly discovered, reconnecting, or no-longer-cached remote environments. It should not be described as happening on every short Settings visit: the primary config has root-level subscribers, and cached remote configs can remain available. A longer absence can also turn the PR reclassification in finding 1 into a network wait.

### 3. Cloud and Focus readiness can produce a false empty list

**Confirmed data behavior; an additional empty-list path, not required for the reproduced warm-navigation blank.**

[threads.ts](../../apps/web/src/state/threads.ts) scopes an environment snapshot through [companyScopedEnvironmentThreads](../../apps/web/src/cloud/agentThreadReadModel.ts). For a selected company, it hides project threads unless the company replica contains both the environment registration and a matching cloud agent-thread record.

A local shell can therefore be loaded while its company-scoped result is empty. Projects use a different filter based on environment bindings, so a project being visible does not prove its thread membership data is ready. A temporary probe held the local snapshot constant and changed only the replica's thread-record availability: visible thread counts were `1 → 0 → 1`, while the project remained visible. In All companies mode the same project-thread filter did not hide the thread.

Focus introduces another prerequisite: [focusReadModel.ts](../../apps/web/src/cloud/focusReadModel.ts) can retain a selected Focus ID while its read model is `null`, and [scopedProjectKeysForFocus](../../packages/client-runtime/src/state/focuses.ts) then returns an empty set for missing assignments. That yields no matching project threads. The screenshot’s “All projects” menu is the project picker **inside** the selected Focus; it does not mean the Focus filter is disabled.

The cloud runtimes are mounted above section navigation. These paths need a concurrent bootstrap, reset, subscription restart, or data change; the source does not establish that going to Provider Settings itself causes one.

The sidebar has no explicit loading/readiness branch for these dependencies. Around line 4832 it treats an empty partition as “No threads yet” or “No projects yet.” The central `/threads` landing does use `useAllEnvironmentShellsBootstrapped`, but that gate does not protect the sidebar or encompass all company/Focus/PR prerequisites.

### 4. Animation makes transient classifications visible and costly

**Confirmed cause of a blank frame in the browser fixture even with the correct rows already present.**

`Sidebar.tsx`, around line 4084, enables `autoAnimate` on the list immediately, with a 150 ms duration and no distinction between hydration and a user changing a thread. The installed `@formkit/auto-animate` implementation starts inserted rows at opacity zero and keeps them there through half of the insertion animation. Movement and removal also animate.

The active list renders every active row; only the Settled tail is paged/collapsed. Temporarily classifying history as active therefore mounts its rows, subscribes to their VCS/PR data, constructs row controls, and animates the later removals. Shared query keys and caches deduplicate some work; this is not necessarily one fresh network request per row. It still makes cost proportional to the mistakenly expanded history.

The browser trace found four rows in a nonzero-height viewport, all with opacity `0` and a `scale(0.98)` transform. The settled header was already correct. A screenshot captured the blank panel, and the reduced-motion comparison removed the blank interval. This accounts for the reported shape of a blank list despite already-loaded data; it does not establish a multi-second blank panel.

Rows also use `content-visibility: auto` and intrinsic height estimates. Their estimated geometry changes as content becomes visible, so containment can interact with movement measurement. The animation comparison did not require removing containment or changing the scroll-area mask; neither was established as a separate root cause.

## Explanations ruled out or narrowed

- **Ordinary navigation always reloads the thread shell:** not supported. `AppSidebarLayout` calls [useThreadVisitedMigration](../../apps/web/src/hooks/useThreadVisitedMigration.ts), which subscribes to `useThreadShells` even on Settings. `ProjectProjectionRetention` also retains projects and the underlying environment snapshot. Simply adding another shell subscriber would not fix the lost PR map.
- **The Settled shelf preference hydrates after each mount:** [useLocalStorage](../../apps/web/src/hooks/useLocalStorage.ts) reads the stored value synchronously through `useSyncExternalStore`. The shelf defaults collapsed.
- **Auto-settle settings reload on every return:** [useSettings.ts](../../apps/web/src/hooks/useSettings.ts) retains a module-level snapshot and hydration flag. Initial startup can have a settings transition, but normal sidebar remounts do not restart hydration.
- **Threads are actually being unsettled by navigation:** the classification probes require no mutation. PR-driven settlement of ordinary threads is a client-derived decision. Temporary-thread server cleanup is a separate flow.
- **A particular provider is responsible:** the identified logic runs before any Codex, Claude, Cursor, Grok, or OpenCode adapter-specific behavior.

## Recommended fix order

1. Move PR-dependent sidebar classification out of component-local row feedback. Preserve the last valid, source-matched classification across section navigation and make it available on the first returning render. Reuse cached query data; retain invalidation when project, branch, worktree, or attachments change. Scope retained state to the account and environment, and remove obsolete entries.
2. Represent unknown capabilities separately from unsupported capabilities. Use an already known compatible environment descriptor/config when available; do not temporarily override known settlement or snooze state merely because an observer is initializing.
3. Give the list explicit readiness for the selected company and Focus. During same-scope refresh, preserve a usable known view where ownership remains valid. For initial loading or a scope change, show a deliberate loading state rather than claiming there are no threads. Clear data on sign-out, membership revocation, or a real scope change. Do not bypass company ownership filters.
4. Keep initial/restored list rendering stable. Animate deliberate additions, settlement and reordering after readiness, rather than replaying restoration as hundreds of animated user actions. Do not keep every hidden row or PR poll permanently mounted to achieve this.

## Verification and coverage

Passed 443 existing focused tests: 178 web tests across PR state, cloud thread discovery, sidebar logic and section navigation; 265 client-runtime tests across settlement, snooze and shell summaries. Five additional temporary characterization probes passed. Probe copies are retained locally under `.pathway/investigations/sidebar-loading`; they are not product regression tests and are not committed as guarantees of the faulty behavior.

A read-only aggregate check of the local live database found 81 nondeleted, unarchived threads: 19 explicitly settled and 62 without an explicit settlement override. This confirms both explicit and derived state exist in the local data, but excludes other environments and does not establish the screenshot's partition. No dev server was pointed at that database and no live state was modified. The browser fixture uses synthetic data only.

| Surface                     | Assessment                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web and Electron            | Share the affected sidebar and state code. Provider Settings, other contextual sections, and desktop-width sidebar-free sections can unmount it.                                                                                                             |
| Navigation controls         | Rail navigation, links, history and commands that leave/re-enter the section reach the same layout branch. Thread-to-thread navigation within the section normally retains the sidebar.                                                                      |
| Mobile web                  | Settings/contextual navigation can replace the sidebar; sidebar-free routes retain the drawer on narrow viewports, so not every desktop unmount case applies.                                                                                                |
| Native iOS in this checkout | Separate Swift implementation. `PathwayCloudModel` owns PR statuses and the lifecycle partition beyond an individual list view. Do not assume the React remount defect applies. Native startup/reset remains a separate verification case. No simulator run. |
| Connection modes            | The classification flaw applies locally and remotely; independently arriving environment/config/PR data can lengthen the transient state over LAN, relay or tunnel. No transport change is required for the primary fix.                                     |
| Providers and contracts     | No provider-specific cause or necessary contract migration established.                                                                                                                                                                                      |
| Reverse transitions         | Fix verification must retain un-settle, unsnooze, pinning, new activity, pending input/approval, PR detachment/replacement and account/company switching.                                                                                                    |

The browser pass covered warm remounts, delayed PR/config/shell delivery, a collapsed Settled shelf, and reduced-motion comparisons. No JavaScript page errors were recorded. The in-app preview failed to initialize, so the approved check used a separate Playwright Chromium context.

Remaining limits: actual cache expiry was modeled by unavailable query inputs rather than waiting five minutes; remote transport, company/Focus rebootstrap and explicit-settlement capability loss were traced in source/helper tests rather than an authenticated multi-environment browser session. Packaged Electron and native iOS were not driven. The browser fixture and scripts are retained locally under `.pathway/investigations/sidebar-loading` for follow-up, with no test entry point left in the shipped app.

## Review follow-up

Company readiness now uses the complete membership-discovery result, published before any company engine starts. Missing or malformed discovery stays pending; a confirmed empty company list is ready. A failed discovery connection or subscription publishes an error after engine teardown, including authorization and upgrade refusals. Normal interruption returns discovery to pending; a new leadership pass resets a previous failure before reading again. Offline environments retain navigable thread rows even when PR status has never loaded.

Retained settled history is eligible for background revalidation on sidebar entry and when a previously unavailable environment connects, once its last conclusive classification is at least five minutes old. Timestamps share the account/company-scoped classification cache; reading an unchanged cached value or receiving an error does not advance them. This deliberately permits up to five minutes of retained history freshness on a return visit; opening a thread keeps its existing live refresh behavior.

The finite pass uses at most four workers and shares successful VCS reads by environment/worktree and attached-PR reads by environment/project/repository/number. For 106 threads sharing a worktree, the entire pass now makes one host read. Fresh history makes zero reads across repeated remounts. Failed reads are not cached, and an eligibility change from disconnected to connected allows another attempt, even if the old failed request completes after reconnection. Unchanged eligibility does not trigger a retry loop. Queued work and result publication stop when the sidebar unmounts. Explicitly settled threads do not need this pass.

Focused regression tests cover discovery failure/recovery/teardown, both failure/reconnection orderings, cache freshness across repeated mounts, full-pass request sharing, environment isolation, and interruption with queued history. These follow-up changes are covered by deterministic unit tests; the earlier synthetic browser recording remains the navigation evidence, and no additional authenticated-client verification is claimed.
