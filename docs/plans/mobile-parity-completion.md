# Mobile parity completion

Started 6 September 2026 from `b58238754375e8db0d6321526bca366582f89d86`.

The completion criterion is working, reachable behavior backed by the same environment and company contracts as desktop, including failure and reversal paths. A route, mock screen, build or design decision alone does not complete a feature. External delivery and production verification are recorded separately.

## Implementation ledger

| Work                                                           | State                                                                 | Evidence and remaining work                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reconnect/action readiness, request deadlines                  | Implemented; integration pending                                      | RPC transport markers, synchronized gate, cancellation/deadlines; 9 regression tests typechecked                                                                                                                                                                                                                                                                  |
| Stable creation retries and durable attachment drafts          | Implemented; integration pending                                      | Stable launch identities and persisted per-account, per-environment drafts; lost-response tests added                                                                                                                                                                                                                                                             |
| Account-isolated local data and offline discovery              | Implemented; integration pending                                      | Issuer/subject storage, expiring bounded cache, authorization-epoch invalidation; source tests added                                                                                                                                                                                                                                                              |
| Thread search, filters, lifecycle, pinned ordering and Focuses | Implemented; integration pending                                      | Native search/filter, rename/archive/restore/delete, pinned ordering, Focus editor and notifications                                                                                                                                                                                                                                                              |
| First-message composer and reliable launch routing             | Implemented; integration pending                                      | Attachments, stash, suggestions, branch picker, reactive post-launch routing; 18 reliability/protocol/composer tests typechecked                                                                                                                                                                                                                                  |
| Source control, PRs, files, terminal and scripts               | Implemented; device verification pending                              | Real Ghostty terminal bundle, script controls, signed assets, PR reviews/reviewers, stale-workspace guards and revision-protected file saves. 23 file/server contract tests and 56 Ghostty tests pass                                                                                                                                                             |
| Calendar and captured email                                    | Core workflows implemented; native alert delivery incomplete          | Calendar hour grid/drag/resize; Email analytics/triggers/history/retention; native Calendar reminders and captured-email banners remain unimplemented; 10 focused Calendar/Email native model/layout tests pass (Contacts/Time has 4 separate tests)                                                                                                              |
| Projects, connections, provider and company administration     | Implemented; live verification pending                                | Direct pairing/account link/managed install/project adoption; settings and diagnostics; company/member/team/role/invitation controls. 8 onboarding and 32 source HTTP tests pass                                                                                                                                                                                  |
| Scheduled tasks, usage and app preferences                     | Implemented; device verification pending                              | Schedule CRUD/run/pause, usage/quotas, favorites, typed environment settings, SC discovery/writing, appearance, keyboard, general and storage preferences; 7 environment settings tests pass                                                                                                                                                                      |
| Push, product links and notification preferences               | Implemented; delivery pending                                         | Native APNs + visionOS relay support; serialized/coalesced registration, account cleanup and thread links. 57 relay/backend tests and 3 native registration races pass. No delivery or deployment proof                                                                                                                                                           |
| Shared contacts and timer data, native workflows               | Implemented; integration pending                                      | Cloud persistence, desktop explicit local import, native models; 12 backend/web and 4 native tests pass; deployment needed                                                                                                                                                                                                                                        |
| Dashboard and orchestrator                                     | Implemented; integration pending                                      | Native and desktop actionable overview; agent entry uses real thread launch. Shared web typecheck/lint pass                                                                                                                                                                                                                                                       |
| Android implementation                                         | Excluded                                                              | User confirmed Android is not supported in this version                                                                                                                                                                                                                                                                                                           |
| visionOS transport and shared UI                               | Implemented; packaging/runtime pending                                | Full real-SDK Swift 6 module emission passes for 145 app sources plus generated symbols, with real Clerk and no service stubs. Resource packaging remains blocked by missing platform component                                                                                                                                                                   |
| Native share/capture, App Intents/widgets/Live Activities      | Implemented within platform support; device verification pending      | Share extension, reviewable drafts, camera/document capture, App Intents, saved work-summary widgets and ActivityKit. Both extensions and Ghostty bundle confirmed in iOS build output. Summary widgets support visionOS; ActivityKit/share/scanner remain iOS-only                                                                                               |
| Accessibility and performance                                  | Large-text and iPad rotation checks pass; broader measurement pending | 44-point attachment actions, VoiceOver calendar resize, Dynamic Type floors, native keyboard commands, cached discovery decoding, bounded history cache and stable streaming order. Largest-text sidebar readability fixed; physical VoiceOver and performance profiling remain required                                                                          |
| Native CI and contract/failure tests                           | Implemented; CI/device execution pending                              | Apple matrix workflow and terminal manifest check added. Integrated iOS arm64 build-for-testing passes; portable native race/model tests pass. 202 native tests pass; iPhone and iPad Conversation/Issues UI runs executed; a board-drop callback crash was fixed and its unchanged UI test plus 2 new native regressions pass. GitHub workflow execution pending |
| Documentation and end-to-end verification                      | Documentation complete; end-to-end verification pending               | User Apple-client guide, connection guide, domain docs and release runbook written. User authorized device/browser verification; simulator results are recorded in apple-client-simulator-verification.md; no production/store claims from fixture evidence                                                                                                       |

## Working boundaries

- Work happens on `codex/mobile-parity-completion`; no publication or store release is included.
- Agents use exclusive file ownership and the primary agent integrates shared navigation/auth/cloud files.
- The primary agent owns integrated builds and UI runs. No subagent starts a development server or simulator.
- Live Pathway data remains read-only. Test environments must use isolated state.
- Every completed entry must record the files, focused proof and external limitations.

## Verification boundaries

- iOS arm64 simulator SDK build-for-testing passed locally on 6 September 2026, compiling the app, extensions and test bundles. The user subsequently authorized execution: 202 native model/contract tests passed on iPhone. See the simulator report for UI runs and subsequent fixes.
- Full visionOS Swift 6 module emission passed with 147 inputs, real XRSimulator 26.2 SDK and real Clerk module, no warnings/errors and unchanged source hashes. Generic scheme/target packaging still stops because the visionOS platform/device-type component is absent. This is source compilation proof, not a packaged or running visionOS app.
- The user authorized local UI/browser verification. Results and remaining live-service boundaries are recorded in [Apple client simulator verification](apple-client-simulator-verification.md).
- Backend and relay changes need deployment; APNs needs matching signing/provisioning and relay credentials. Neither deployment nor notification delivery has been exercised.
- The native CI workflow is checked in as code only and has not run on GitHub.
- File revisions serialize competing Pathway API saves. An independent filesystem writer can still race the final write; portable filesystem APIs do not provide compare-and-swap for arbitrary external processes.
- Company purge is an existing backend TODO; new shared business tables must join that future purge implementation.

## Final integration review

Independent source reviews found and fixed stale workspace mutations, unsigned original-file routing,
wrong mobile registration scope, overlapping APNs preference writes, delayed authentication and
subscription callbacks, authorization epoch changes during bootstrap, removed membership work,
replaced environment sockets, secondary visionOS account state, repeated shortcut state and obscured
thread navigation. Focused tests use actual models with controlled continuations; portable harnesses
stub platform/service boundaries and do not establish live Clerk/Convex/APNs behavior.

Additional focused proof: 9 cloud lifecycle tests, 4 environment connection lifecycle tests,
3 account preparation tests, 2 conversation ordering/cache tests, and 35 shared domain tests pass.
Web and backend package typechecks and changed-file TypeScript lint pass. A server-scoped typecheck
reported a CryptoKey typing issue in the unmodified `packages/backend/src/integrationCredentials.ts:96`;
focused server HTTP and workspace tests pass.

## Deliberate platform adaptations

- Native fonts, color scheme, Dynamic Type and five relevant configurable keyboard commands replace
  web CSS theme/font machinery and desktop-only shortcuts.
- Phone app settings remain device-local, matching the desktop client-settings boundary. Environment
  settings use the real server API and changed-leaf patches. Advanced background overrides use a
  fresh read/merge; the existing server has no compare-and-swap contract for simultaneous map edits.
- Git-host authentication stays on the environment. Native shows actual installed/authenticated
  state, account details, guidance and rescan; it does not invent a host-login RPC.
- Projects has All and Recent. Project archive/restore has no server mutation contract and is not
  advertised as an active sidebar destination. Removal preserves the project files.
- Desktop host/server execution, Electron window management, browser inspection/annotation, web-only
  CSS themes and Android are outside this Apple client parity implementation.
- Small/medium work-summary widgets read account-scoped saved counts and show snapshot age; they do not claim a live background cloud subscription. Four store tests pass. The system schedules widget redraw after reload requests, including signout clears.

## Remaining implementation work found during verification

These are feature gaps, not deployment-only gates:

1. **Company Integrations management:** native Slack intake still uses environment-local token/watch RPCs. Desktop has a separate company-owned Integrations manager with primary/backup controllers, activation/health, V2 routing and shared automation. Native needs its company client and a reachable Settings workflow. See `apps/web/src/cloud/companyIntegrations.ts` and `apps/web/src/components/settings/integrations/IntegrationsSettingsPanel.tsx`; the current native surface is `PathwayIssueSlackSettingsView.swift`.
2. **Calendar reminder delivery:** native saves reminder settings but does not subscribe to `calendars:listAlertEvents` or schedule native notifications. Finish account-scoped scheduling, deduplication, event navigation and cancellation on edits/deletion/signout. Desktop's `calendarAlerts.tsx` and the existing backend query establish the contract. Saving reminder minutes does not prove delivery.
3. **Captured-email banners:** native writes environment `toastsEnabled` and project `toastMuted`, but has no cross-route foreground banner host. Implement event deduplication, source preference/mute handling and Open-message navigation comparable to desktop `EmailCaptureToastHost.tsx`. Detected codes are already available in native message details.

The 7 September follow-up resolves the prior two UI failures: iPhone now explicitly uses portrait only, and disconnecting the iPad Simulator hardware keyboard passes the original picker keyboard assertions. The 25 selected UI workflows per device have focused passing evidence across the verification runs. The implementation must not be described as complete desktop parity or ready for release while these items remain.

## Remaining release gates

1. Complete the integrated iPhone/iPad live-service and physical-device flows, including VoiceOver,
   keyboard/IME, multitasking, reconnect, large histories and real provider behavior. Largest Dynamic Type
   and iPad rotation have simulator proof. The requested iPhone portrait policy and iPad software-keyboard setup now have passing focused checks.
2. Install Xcode's missing visionOS platform component, build the full app and verify the spatial
   client against real authentication/cloud/relay. Full Swift module emission is complete; resource/link/runtime verification remains required.
3. Configure signed app/extension/App Group/APNs/universal-link capabilities and verify physical
   device delivery, share imports and account cleanup.
4. Deploy compatible backend, relay and source environment services; execute cross-device data and
   onboarding checks. No deployment, Git publication or store submission was performed.

See [Apple client release verification](../operations/apple-client-release.md) for the concrete flow.

Final local logs: `.pathway/evidence/vision-swift-module/` records the exact command, input hashes,
empty diagnostic log and exit code 0. `/tmp/pathway-ios-parity-tests-build.log` records the final
successful iOS arm64 build-for-testing, including the broadened widget target and both extensions.
Simulator execution is now documented in [Apple client simulator verification](apple-client-simulator-verification.md). The code remains uncommitted on the implementation branch.
