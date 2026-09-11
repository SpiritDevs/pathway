# Desktop startup performance audit — 12 September 2026

The reported 30-second launch is supported by the traces on this Mac. Six retained launches took **23.9–60.0 seconds from the desktop startup span to main-window creation**. The latest took **29.0 seconds**, including **27.5 seconds waiting for the backend**. These are lower bounds on time to a usable conversation: module loading before the startup span and renderer authentication/loading afterward are not fully included.

The main issue is startup work growing with conversation history. Changing the splash animation or Electron window settings will not remove that work.

The pre-rebase rescan brings the median measured process-spawn-to-authenticated-dashboard time from **18.57 to 9.85 seconds** on the same isolated profile, a **47% reduction**. Three repeats ranged from **9.00 to 10.20 seconds**. The first launch building the additional indexes took **14.15 seconds**. This reaches a sub-10-second median, not a reliable sub-10-second ceiling or a measured result for the installed release. The test account's dashboard is empty while the backend holds the representative history; the endpoint limits below matter.

The fixes cover thread-identity lookup, recovery candidate selection, unnecessary startup shell snapshots, and event-maintenance scans. Full projection verification remains intact. Visual design, accessibility, and theming were outside this performance audit.

## Integration with main before opening the PR

The integration build and checks used main `48abbfe1e6`. Before opening, the PR was rebased again onto `2362cc6ffd`; those intervening changes affect web/iOS clients and user documentation, leaving the tested server code unchanged. Main already includes PR #139's provider-runtime candidate selection, provider-probe deferral, bounded projection rebuild, and live event subscription changes. Those implementations remain in place. The duplicate runtime candidate method and idle-thread recovery loop from the audit experiment were removed; the final branch uses main's `getRecoveryThreadIds`, including its pending/running outbox candidates. Added shared-session and cross-thread provider regression assertions exercise that existing path.

The retained changes add migrations 070/071, focused metadata/queued-run/subagent/delegated-delivery queries, browser-takeover metadata filtering, and direct remote-browser cursor access. The timing tables below describe the measured pre-rebase builds, not a matched benchmark against the newer main. One post-rebase launch without frame capture reached the authenticated dashboard in **10.61 seconds**, with the main window visible at **9.84 seconds**. This is a single validation run, not a new median or a matched comparison with main.

Post-rebase validation: 122 tests passed across the eleven targeted migration, recovery, projection, turn-control, replay, and browser files. The server TypeScript check and scoped production desktop build passed. A broader `runtimeLayer.test.ts` run had 27 passes and 10 failures; running that unchanged file on clean main `48abbfe1e6` produced the same ten failures, all `RuntimePolicyResolveError` from missing project fixtures. This PR leaves those pre-existing fixtures unchanged. [Short launch recording](../../.github/pr-assets/startup-after.webm): an isolated launch of the rebased build, captured from its first visible splash through the empty test-account dashboard. Frame intervals are preserved; frames were resized and encoded at 10 fps. The recording excludes the initial process-to-splash interval and adds capture overhead, so it is illustrative evidence rather than a timing benchmark. The captured launch reached the dashboard 13.26 seconds after process spawn.

## Evidence and limits

- Historical evidence: six completed desktop startup/readiness traces from 10–12 September, plus the server trace for the latest launch. Times below are Australia/Sydney.
- Installed app inspected: `0.0.42-nightly.20260911.114`, commit `694239ac771d`. Source reviewed and benchmarked at repository HEAD `5e250960f2`, with existing unrelated working-tree changes left intact.
- Representative database: a consistent `VACUUM INTO` snapshot from a read-only connection to the live database. It contained 105,082 events, 250 thread projections, 249 non-deleted threads, and 3,522 messages. The live database file was 1.26 GiB.
- Service benchmarks used the current source's `NodeSqliteClient`, `ProjectionStoreV2`, and `ProjectionMaintenanceV2` against the snapshot. Projection verification passed with no missing or unreadable threads. Those benchmarks did not start orchestration workers. The later full-app measurements used a separate, isolated copy described below.
- An isolated Electron instance loaded the installed app code with separate Pathway state and Electron user data. It used a fresh database, disabled updates/protocol registration, and reached the sign-in screen. No production login was automated. The test instance was stopped after measurement.
- That initial isolated launch is an empty-state reference, not a populated-account benchmark or an OS-cold launch. The installed code was loaded by a small harness using the repository's Electron runtime. The later measurements below include a fresh build and retained development login, with limits on restored account history.
- SQL and service benchmarks ran on this Mac alongside its existing workload. No filesystem cache purge was performed. First-read and repeated-read times differ substantially; do not add overlapping span durations or treat a SQL span as pure CPU time.

| Recorded launch | Shell environment | Backend readiness wait | Startup span → main window created |
| --------------- | ----------------: | ---------------------: | ---------------------------------: |
| 10 Sep 12:19    |            1.19 s |                23.14 s |                            24.53 s |
| 10 Sep 12:27    |            1.28 s |                22.39 s |                            23.87 s |
| 10 Sep 16:19    |            1.22 s |                58.54 s |                            59.98 s |
| 11 Sep 08:01    |            1.53 s |                31.81 s |                            33.51 s |
| 11 Sep 08:06    |            2.53 s |                21.79 s |                            24.43 s |
| 12 Sep 06:29    |            1.38 s |                27.45 s |                            29.04 s |

The latest server trace separates two substantial sequential stages:

| Stage                                | Recorded duration | Detail                                                            |
| ------------------------------------ | ----------------: | ----------------------------------------------------------------- |
| `orchestrationV2.Orchestrator.layer` |           12.20 s | Shell reads and startup recovery before the runtime startup phase |
| `server.startup`                     |           12.29 s | Includes the verification and recovery phases below               |
| ↳ Projection verification            |            9.99 s | Thread identity lookup alone occupied a 6.98 s SQL span           |
| ↳ Provider runtime recovery          |            0.60 s | Required restart reconciliation                                   |
| ↳ Browser takeover recovery          |            1.55 s | Required reconciliation of persisted takeover state               |

In the fresh isolated instance, the splash became ready to show at 2.54 seconds, the main window was created at 5.21 seconds, and became ready to show at 6.33 seconds, measured from harness initialization. Renderer first contentful paint occurred 1.14 seconds after navigation. This demonstrates substantial history-dependent cost, while also leaving a several-second baseline to improve.

## Full-app remeasurement after the first two fixes

Rebuilt the web, server, and desktop production artifacts with `vp run --filter @spiritdevs/desktop build`. Measured on this Apple M1 Mac with 16 GiB RAM and macOS 27.0, using Electron 41.5.0. The harness loads the built desktop entry with packaged-mode path resolution; this is not a newly signed or installed release. The build includes the existing working-tree changes. Normal machine workload and filesystem caches were left in place.

All times in this table start immediately before spawning Electron, so they include process/module initialization. Main-window visibility is Electron's `show` event. Dashboard readiness is the signed-in Dashboard and New agent thread control appearing in the DOM, followed by two animation frames. It does not wait for every background request.

| Launch                                | Splash visible | Main window created | Main window visible |   Signed-in dashboard painted |
| ------------------------------------- | -------------: | ------------------: | ------------------: | ----------------------------: |
| First launch, including migration 070 |         3.96 s |             18.31 s |             22.89 s | Not measured; initial sign-in |
| Repeat 1                              |         2.69 s |             14.20 s |             17.72 s |                       18.57 s |
| Repeat 2                              |         2.81 s |             13.48 s |             17.66 s |                       18.51 s |
| Repeat 3                              |         2.81 s |             13.35 s |             17.83 s |                       25.39 s |

The repeat-launch median to the signed-in dashboard is **18.57 seconds**, with an observed range of **18.51–25.39 seconds**. Main-window visibility is consistent at **17.66–17.83 seconds**. The third run adds 7.56 seconds between showing the window and painting the dashboard, versus about 0.85 seconds in the other two. The endpoint measurements establish that delay; they do not isolate its cause among authentication, cloud initialization, and renderer work.

The historical 23.9–60.0-second measurements above end at window creation and start later than process spawn. They are not a matched baseline for these dashboard measurements. This first remeasurement provided the process-to-dashboard baseline for the additional rescan below.

Isolation and endpoint limits:

- Used a separate copy of the representative database, retaining approximately 105,000 events, 250 thread projections, and 3,522 messages. Workspace/worktree paths point to disposable directories and project scripts are cleared. The original snapshot and live installation were not changed.
- Confirmed the copy had no queued runs, pending/running outbox effects, scheduled tasks, or launch workflows before starting it. The app performed normal startup recovery on the copied state. Migration 070 was absent on the first launch and present on repeats.
- Pathway home and Electron user data were both isolated; updates and default protocol registration were disabled. The desktop's normal network/authentication behavior remained enabled.
- Used a dedicated Clerk development account and retained its login for the three repeats. Its dashboard did not retain the original account's project/thread history, although the backend loaded the populated database. These numbers therefore measure startup to the test account's dashboard, not complete restoration of the original account's populated conversation UI. Opening a new conversation produced an editable composer; that manual navigation was outside the timed endpoint.
- During account setup, historical review threads attempted recovery publishing and displayed failure notifications. Publishing was disabled in the disposable review titles before all repeat measurements; history remained present. This fixture adjustment avoids republishing historical reviews from a new browser profile and reduces associated background renderer work.
- All four test app processes exited cleanly after measurement. Raw timestamps, per-run span extracts, screenshots, fixture, and harness are retained locally under the audit temporary directory's `total-launch/` folder. Credentials are outside the repository and excluded from the report.

The repeat traces still show 3.19–3.47 seconds in orchestrator initialization, 1.29–1.38 seconds in projection verification, 1.39–1.44 seconds in provider runtime recovery, and 1.43–1.74 seconds in browser-takeover recovery. Shell discovery adds 1.10–1.32 seconds before the splash. Backend readiness remains a major part of the wait.

There is also contention after readiness: `server.startup.heartbeat.record` lasts 2.70–3.55 seconds on repeats, overlapping renderer loading. On the first launch, its `ProjectService.readRows` child span occupies 3.72 of 3.93 seconds. This is an observation of elapsed span time, not proof that the heartbeat itself consumes that much CPU. Profile the remaining full-history reads and background database contention, then separately trace the variable window-to-dashboard delay.

## Additional rescan: recovery and event maintenance — fixed

Rebuilt the server with the additional optimizations and reused the same desktop/web build, isolated populated backend, retained development login, and timing endpoint. Builds and checks were stopped before timed launches. No filesystem cache purge or machine restart was performed.

| Launch                           | Splash visible | Main window created | Main window visible | Signed-in dashboard painted |
| -------------------------------- | -------------: | ------------------: | ------------------: | --------------------------: |
| Repeat 1 (`rescan3`)             |         2.92 s |              8.16 s |              9.18 s |                     10.20 s |
| Repeat 2 (`rescan4`)             |         2.19 s |              8.09 s |              9.14 s |                      9.85 s |
| Repeat 3 (`rescan5`)             |         2.13 s |              7.11 s |              8.09 s |                      9.00 s |
| First upgrade with migration 071 |         3.13 s |             12.28 s |             13.32 s |                     14.15 s |

Median dashboard time fell **8.72 seconds (47%)**, from 18.57 to 9.85 seconds. This comparison uses the same endpoint; it does not compare dashboard readiness with the historical window-creation spans. The authenticated dashboard still does not restore the original account's projects and conversations. A real populated-account acceptance run, signed release, OS-cold start, and slower hardware remain to be measured. All isolated processes were stopped by their captured PIDs.

The additional changes are:

- **Metadata instead of UI snapshots:** settlement-index seeding and settlement recovery read thread metadata. Queued-run recovery selects only threads containing queued runs. Browser-takeover recovery loads history only when a nonterminal takeover marker exists. Archived/deleted filtering is preserved, and candidates still pass through the existing recovery checks and locks.
- **Terminal child recovery:** select only terminal app-owned child tasks without an existing result transfer. Provider-native and already-transferred children no longer load full child/parent histories during this pass. Recovery still rechecks the current state under the parent lock.
- **Runtime recovery:** select threads with nonterminal runs, requests, background work, live provider sessions, or active/background provider threads. Include provider relationships through direct thread ownership, owning nodes, and subagent references. The query selected the same **8 of 249** non-deleted threads as a full-projection predicate check on the representative copy. Idle threads still have unsettled process-bound effects cancelled and their waiters notified. Startup and shutdown use the same behavior.
- **Remote browser cursor:** read the event sequence directly instead of building the entire sidebar snapshot just to obtain its cursor. The durable cursor is still captured before exposing browser operations, and deletion catch-up remains in place.
- **Event maintenance:** migration 071 adds covering indexes for thread-state compaction and entity-update compaction. The old queries read historical payloads and delayed unrelated startup requests even after command readiness opened. On the copy, the thread-state candidate query fell from about **2,243 to 16 ms**. Message/node/turn-item scans fell from roughly **1,037/171/623 ms to 2/16/19 ms**, with identical candidate IDs. No compaction or event-retention rules changed.

In the final three app traces, orchestrator construction took **640–794 ms**; runtime recovery took **137–152 ms**. The heartbeat write after activation took **424–467 ms**, down from multi-second waits during event-maintenance scans. Full projection verification still took **1.29–1.97 seconds**, and shell environment loading took **1.06–1.26 seconds**. These overlapping phase timings are not additive launch-time savings.

The two new maintenance indexes occupied approximately **25 MiB** for 105,031 events. In the upgrade measurement their creation took **1.89 seconds**, with the complete migration phase taking 2.14 seconds. The upgrade run also experienced different process/loading timings, so its total difference from warm repeats cannot be attributed entirely to the migration. Both indexes add storage and event-write maintenance; this audit does not establish steady-state event-ingestion throughput.

The final focused run passed **60 tests across seven files**, covering SQLite and memory candidate selection, archived/deleted threads, terminal child statuses, provider-native exclusion, existing result transfers, settled background providers, shared sessions, cross-thread provider references, idle-effect cancellation, migration results/query plans, and remote-browser behavior. Earlier integrated recovery checks, browser-takeover tests, and replay recovery tests also passed. The server TypeScript check and targeted lint/format checks passed; lint reports two existing warnings in untouched code.

## High: startup thread discovery reads the event history — fixed

Location: [ProjectionMaintenance.ts](../../apps/server/src/orchestration-v2/ProjectionMaintenance.ts), `verify`.

Verification selects distinct thread IDs from V2 `thread.created` events. SQLite chose the general `(aggregate_kind, stream_id, sequence)` index, then read event rows to filter by version and event type. That makes discovering roughly 250 identities depend on the much larger event history and its payload storage.

Added [migration 070](../../apps/server/src/persistence/Migrations/070_StartupThreadCreationIndex.ts): a partial covering index on `(application_event_version, aggregate_kind, event_type, stream_id)`, containing only V2 thread-creation events. Keeping the equality columns in the key matters: an initial experimental index on only `stream_id` was ignored without statistics. The final index was selected without `ANALYZE`.

Measurements through the app's SQLite adapter on the database snapshot:

| Measurement                           |                                  Before |                  After |
| ------------------------------------- | --------------------------------------: | ---------------------: |
| First measured lookup in that process |                                1,523 ms |                0.31 ms |
| Subsequent lookups                    |                          149.9–151.9 ms |           0.15–0.26 ms |
| Result identities                     |                                     250 |   Same 250, same order |
| Query plan                            | General stream index plus row filtering | Partial covering index |

Index creation took 133 ms after the baseline reads had warmed the relevant pages. A first upgrade with uncached data can take longer. The index contains only creation events, so ordinary message and tool events do not add entries to it. It does not change projection validation, event retention, or recovery semantics.

This is a query-level improvement, not a measured reduction of total packaged-app launch time. The 6.98-second production SQL span includes the conditions of that launch; it is not a guaranteed seven-second saving on every machine.

## High: delegated-completion recovery hydrates every thread — fixed

Location: [Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts), startup recovery immediately after `resumeQueuedRuns`, especially the loop calling `getThreadProjection` before and after inspecting delegated completion.

Previously, this loop visited every non-deleted thread, including archived threads, and loaded its full projection twice. Most threads have no delegated completion to reconcile. Full projections include messages, tool results, runs, and related history; concurrency of eight does not make synchronous SQLite reads and JSON decoding run on eight CPU cores.

On the snapshot, two full passes over 249 threads took **3.26–3.35 seconds** in isolated service benchmarks. Only **3 threads** had relevant delegated-completion messages or pending delivery state. A prototype candidate query took **6–10 ms**; reading those three projections twice took **159 ms**. Its selected IDs matched a full-projection check of the same predicates on this snapshot.

Implemented `getDelegatedCompletionRecoveryThreadIds` in the SQLite and memory projection stores. It reads delivery markers from messages and runs, includes archived threads, excludes deleted threads, and returns each candidate once. The orchestrator reads candidates after child-result recovery has had a chance to reserve deliveries, then performs the existing reconciliation under the existing thread locks. Malformed JSON remains a candidate for per-thread error handling so one corrupt payload cannot abort discovery for every thread.

Measured the implemented method on the same snapshot, alternating the old selection plus two projection reads per thread with the new selection plus the same reads for candidates. The database was opened read-only and no recovery mutations or provider work ran:

| Trial | Previous data-loading path | New data-loading path | New selection query |
| ----- | -------------------------: | --------------------: | ------------------: |
| 1     |                   3,717 ms |                174 ms |              7.3 ms |
| 2     |                   2,406 ms |                181 ms |              7.0 ms |
| 3     |                   2,383 ms |                170 ms |              6.9 ms |

For this pass, full-projection reads fell from **498 to 6**, with identical relevant thread IDs. Median measured data-loading time fell by approximately **93%**. These measurements exclude the actual delivery mutations, other recovery passes, projection verification, and renderer startup; they are not total app launch times.

[Recovery regression tests](../../apps/server/src/orchestration-v2/DelegatedCompletionRecovery.test.ts) cover both stores, empty/ordinary history, message-only and run-only candidates, deleted and archived threads, multiple markers, changes between reads, and malformed payloads. Tests acquire the actual orchestrator over persisted SQLite fixtures for each terminal delivery status: completed, interrupted, failed, cancelled, and rolled back. They check archived settlement and task ownership, pending re-offers, second-restart duplicate prevention, and that unrelated archived threads receive no full projection reads. The existing delegated-delivery, projection-store, provider-turn-control, and Codex/Cursor replay recovery tests also pass.

## High: verification decodes every full projection before readiness

Location: [ProjectionMaintenance.ts](../../apps/server/src/orchestration-v2/ProjectionMaintenance.ts), the `actualIds` loop in `verify`; [serverRuntimeStartup.ts](../../apps/server/src/serverRuntimeStartup.ts), `orchestration-v2.projections.verify`.

Every launch decodes every stored thread projection, including historical messages and tool results. This is separate from the repeated recovery reads above. Verification took **3.34–3.47 seconds** in isolated service benchmarks before adding the index, and **9.99 seconds** in the production startup trace. The added index fixes identity discovery but leaves the full projection reads in place.

Recommended design work: preserve cheap schema-version, sequence, and thread-identity checks at the readiness boundary. Evaluate a durable validation record tied to the projection schema and validated sequence, with explicit invalidation for upgrades, rebuilds, and interrupted validation. Full validation must still detect malformed projections and trigger safe repair. Do not simply remove validation or mark the server ready while a destructive rebuild can race commands.

Required verification: missing and unexpected threads, unreadable payloads, projection sequence mismatch, schema changes, crash during validation/rebuild, and command gating during repair. Measure the normal unchanged-database restart separately from the exceptional repair path.

## Medium: repeated startup shell snapshots — fixed

Location: [Orchestrator.ts](../../apps/server/src/orchestration-v2/Orchestrator.ts), settlement-index seeding and recovery loops; [ProjectionStore.ts](../../apps/server/src/orchestration-v2/ProjectionStore.ts), `getShellSnapshot` and `selectShellThreadRows`.

Multiple startup tasks requested the complete UI shell even when they needed only a thread ID, a settlement flag, lineage, or an event cursor. The rescan replaces these reads with the focused queries described above. Building the full shell includes correlated lookups for runs/messages/requests, item counts, background work, and pull-request attachments. A shell snapshot took **1.03–1.13 seconds** in the original source service benchmarks; the first production shell transaction occupied **2.70 seconds**.

The full shell query remains available to the UI. Recovery makes fresh reads between mutation phases; there is no unconditional startup snapshot cache that could hide recovery changes.

## Medium: the renderer and early feedback wait behind server preparation

Locations: [DesktopApp.ts](../../apps/desktop/src/app/DesktopApp.ts), `startup`/`bootstrap`; [DesktopBackendPool.ts](../../apps/desktop/src/backend/DesktopBackendPool.ts), primary `onReady`; [server.ts](../../apps/server/src/server.ts), global `commandReadinessLayer`.

The desktop completes shell environment loading before it shows the connecting splash, then waits for backend command readiness before loading the main window. The global HTTP middleware also gates static renderer requests. Consequently renderer loading and cloud authentication begin after the expensive server work instead of overlapping it.

Recommendations, in order:

1. Move visible startup feedback earlier on macOS while retaining shell environment installation before provider subprocesses launch. Measured shell setup was 1.19–2.53 seconds; its timeout is five seconds, with a separate launchctl fallback budget.
2. Investigate serving the renderer shell while recovery proceeds, with explicit readiness for commands and data. Static asset access can be separated from command readiness; authentication requirements must remain intact. Every failure/retry path needs a truthful visible state.
3. Measure time to the authenticated sidebar and usable composer, not just `ready-to-show`. Earlier window painting is useful, but does not itself make the app usable.

## Practices to preserve and secondary observations

- Startup already has useful tracing and a command gate. Keep the recovery boundary and expand timing coverage instead of replacing it with fixed delays.
- Compaction and many auxiliary services already wait until activation. Preserve that separation. Provider checks in the latest trace started after activation; they do not explain the initial backend wait.
- Project metadata enrichment runs before readiness in this trace, but `getAvailable` queues it instead of awaiting network/filesystem completion. Its long spans are not proof that it directly blocks startup. It can still contend for resources; measure an activation-gated experiment after the primary issues are addressed.
- SQL spans after readiness include long waits as well. Synchronous database work and decoding can delay unrelated fibers. More concurrent background startup work is not automatically faster.
- The client root route already sets `pendingMinMs: 0`; there is no default half-second router floor to remove there.

## Follow-up order and performance targets

1. Review the implemented indexed queries and focused recovery reads, then validate a signed release against an authenticated account with populated projects and conversations. Include first upgrade and cold launch.
2. Redesign repeated full validation with an explicit correctness model and restart regression coverage. It still costs 1.29–1.97 seconds on the final repeats; never skip correctness checks without a reliable invalidation and repair boundary.
3. Overlap renderer loading with backend readiness, and show feedback before shell discovery where safe. The final main-window-to-dashboard interval is about 1.7–2.0 seconds, and shell discovery still costs about 1.1 seconds. These are opportunities to investigate, not guaranteed savings.
4. Add durable startup milestones and a representative large-history benchmark to catch regressions: process start, splash shown, HTTP listening, command ready, renderer first paint, authenticated shell, usable composer. Track a percentile comfortably below ten seconds instead of treating the current 9.85-second median as a ceiling.

Proposed acceptance targets for this class of Mac: visible feedback within 500 ms, normal populated-database command readiness below 3 seconds, and a usable authenticated window below 5 seconds. These are engineering targets, not results achieved by this change. Track warm restart, first launch after upgrade, and repair separately; add a larger history fixture to check scaling.

## Surfaces and validation

- **Desktop:** measured on macOS; these optimizations ship in the bundled server on every desktop platform. No Electron or renderer behavior changed in this patch.
- **Web and mobile:** both benefit when connecting to a server that is starting. Mobile startup itself and an already-running remote server were not benchmarked.
- **Providers:** these optimizations are provider-independent. Codex, Claude, Cursor, Grok, and OpenCode adapter behavior is unchanged. Recovery tests cover all terminal V2 run states; existing Codex and Cursor replay restart tests pass.
- **Connection modes:** the fix is local to the environment's database and requires no origin, transport, tunnel, or relay changes.
- **Entry points, contracts, reverse states:** no new UI entry points, wire changes, or user-facing state transitions. This is an internal query optimization; contributor documentation is this report.
- **Checks completed:** focused migration, recovery, delivery, projection, turn-control, replay, and browser checks; targeted lint/format checks; and the server TypeScript check. The final focused run passed 60 tests across seven files. Typecheck passed with existing advisory Effect suggestions outside these changes. Migration tests check result preservation, covering-index selection without `ANALYZE`, subsequent inserts, and migration restart behavior.
- **Full-app measurement:** scoped production builds passed. The final three authenticated repeat launches had a dashboard median of **9.85 seconds**, range **9.00–10.20 seconds**; migration 071's first upgrade took **14.15 seconds**. Complete restoration of the original account's populated conversation UI and OS-cold launch remain unmeasured. The installed app and live database were not updated during this work.
