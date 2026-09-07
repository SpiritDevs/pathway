# Astra, questions during work, and browser readiness audit

Date: 2026-09-07. Status: source audit complete; implementation authorized and in progress. The findings below describe the audit baseline; the implementation update records resolved paths and remaining verification.

Corey subsequently expanded browser scope to agent-usable password managers and passkeys, reliable tabs, and screenshot/video capture. See the [browser audit extension](browser-readiness-extension-2026-09-07.md) for additional source findings, upstream candidates, feasibility questions, and proposed acceptance criteria.

## Scope and evidence

Pathway was inspected at b58238754375e8db0d6321526bca366582f89d86 in the fde6 worktree. The checkout was clean and detached when the audit began. Only audit and design documentation was added during the initial audit; feature implementation began after Corey authorized it.

The comparison uses pingdotgg/t3code at ea646c0834a3394ecb0be4a30c5d367e5a9002bd. A separate temporary checkout contains history since August 23, covering the requested August 24 through September 7 interval. Corey's existing T3 checkout is an older fork and was not changed. Relevant commits were inspected directly, rather than inferred from release notes.

The installed command-line binary reports codex-cli 0.152.1. A short-lived app-server process successfully initialized and returned six models from the default CLI configuration; none had the slug gpt-6-astra. No conversation or model generation was started. This result applies only to that binary and default configuration, not every Pathway provider instance or the Codex desktop app. The process was stopped using its captured process handle.

Official guidance was fetched from the [Astra migration guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra#gpt-6-astra-migration-quickstart), [model reference](https://developers.openai.com/api/docs/models/gpt-6-astra), and [app-server documentation](https://learn.chatgpt.com/docs/app-server). The actual async-question behavior was checked against the [OpenAI handler at a pinned revision](https://github.com/openai/codex/blob/d979df154cf60e13eafb5453e75b6d84f21c67bf/codex-rs/core/src/tools/handlers/request_user_input_async.rs).

The [computer-use guide](https://developers.openai.com/api/docs/guides/tools-computer-use), [async-tool guide](https://developers.openai.com/api/docs/guides/async-tool-calling), and [steering guide](https://developers.openai.com/api/docs/guides/steering) were also read. API async tool outputs still correlate with the original call id. Codex's async question handler is a different abstraction: it has already returned before the user's later message arrives. API steering acceptance also does not mean the model has acted on the input, and does not cancel tools already running.

The requested grill-with-docs skill delegates to grilling and domain-modeling. Those dependencies were absent from the searched installed skill locations. This document records the source audit and direct product interview; it does not claim those missing skills ran.

## Implementation update

The question backend now distinguishes message replies from live RPC continuations, preserves optional blocking/secret/custom-answer/multi-select metadata, and turns completed async agent messages into stable request cards. The generator compatibility transform now retains the structured `questions` field that the pinned upstream schema omitted; regenerated schemas are checked in. This corrects the initial assumption that generated decoding already preserved the field.

Answers are validated and saved atomically with resolution and an outbox effect, using the original provider conversation. Active work is steered; idle work starts a follow-up. A confirmed completion/steering race uses the same saved answer in a follow-up. Duplicate provider delivery cannot resurrect a resolved group. Runtime recovery preserves unanswered message requests, and failed or unreceipted delivery reopens the question for explicit retry. Blocking requests rank ahead of non-blocking requests in the task summary. See the [accepted design and verification record](../adr/0014-astra-questions-and-browser-scope.md#async-question-implementation-and-evidence).

Focused verification passed 82 tests across six backend files, including four recorded-protocol integration scenarios for active answers, answers after completion, completion racing with steering, and an answer delivered to a native child agent. Native child turns have no Pathway run; steering now handles that state without redirecting to the parent or inventing a run. The client/protocol suite separately passed 13 tests. RPC handlers now expose the envelope id and provider resolution matches the exact native thread/id, cancels its card, and interrupts the stale handler without submitting an answer. The browser host-selection and takeover suites separately passed 93 tests. Host selection now stays with the chosen browser for that task across provider-session changes and host reconnects, rejects unsafe switches during actions/takeover, and keeps list operations read-only. This selection preference is process-local and does not yet persist across server restarts.

Live local verification subsequently completed against Astra in the isolated worktree environment: the original turn left a pending question, an authenticated typed-RPC “Blue” answer started one same-conversation follow-up, and Astra replied “Blue selected.” Repeating the same command returned the identical receipt (sequence 54); one answer message and two total runs remained. The start outbox succeeded on its first attempt. The client draft was separately held in “Sending” because active-company filtering requires a published cloud thread replica while this environment was unlinked. These are distinct provider-delivery and client-presentation boundaries.

Remaining boundaries: no live browser or iOS proof is implied; a crash after provider acceptance but before a durable receipt is an uncertain-delivery state, not an exactly-once guarantee. The original findings below remain as historical evidence, rather than claims that every listed defect is still present.

## Assessment

Adding Astra to a list is insufficient. Pathway has dynamic Codex model discovery, a generated protocol boundary, a question picker, active-turn steering, and a substantial browser automation implementation. The missing work connects those pieces correctly and fixes several existing browser limitations.

The largest integration gap is that an async Codex question is an assistant message carrying structured questions. Its answer is a later user message. The current Pathway V2 adapter treats the item as ordinary assistant text and provides only process-bound RPC question replies.

There are three independent concerns: model availability and presentation, durable question delivery, and the browser host. A remote model manifest can improve presentation without granting account access or installing a browser runtime.

## Findings

### A1. Async questions never become actionable request cards. P1, confirmed source defect

OpenAI's request_user_input_async handler emits item/started and item/completed with an agentMessage containing delivery=async and questions. It returns accepted immediately. The item uses final_answer phase, which does not mean the whole turn ended.

Pathway's generated schemas already preserve delivery and questions. The active [CodexAdapterV2](../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts) handles agentMessage at lines 3633 and 3912 onward without checking either field. The completed branch forwards text through the normal message coalescer. It creates no user_input_request item or durable reply target for these messages. A plain-text question can therefore appear while the actual picker is absent.

Required work: recognize the structured notification, create one stable question group, deduplicate started/completed/replayed events, and preserve its originating provider thread. Keep turn completion tied to provider lifecycle events. Cover root and native subagent messages, resumed history, empty options, Unicode, and malformed payloads.

### A2. The existing answer path cannot deliver async-question replies. P1, confirmed architectural gap

[Runtime request contracts](../../packages/contracts/src/orchestrationV2.ts) allow live provider-session responses or not_resumable. [RuntimeRequestService](../../apps/server/src/orchestration-v2/RuntimeRequestService.ts) requires the original active process. CodexAdapterV2 responds by completing a Deferred for a pending JSON-RPC handler.

Async questions have no pending JSON-RPC handler. Their answer must be saved as a user message, then use Pathway's existing steer/start path. The adapter already calls turn/steer at line 4829. Do not invent a new raw Responses API connection or try to respond to the completed tool call.

Required work: distinguish reply transport from whether a question blocks work. Commit question resolution and the durable outbound answer together. Route it to the originating provider thread. A root answer must not accidentally reach a subagent or a newly selected provider. Handle the race between active-turn steering and turn completion without duplicating or dropping the answer.

### A3. Recovery currently expires every pending runtime request. P1 for the accepted persistence requirement

[ProviderRuntimeRecoveryService](../../apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts:158) selects all pending requests and expires them at startup or cancels them at shutdown. This is appropriate for a dead RPC continuation, but would discard a message-replied question that remains answerable after restart.

Corey explicitly selected persistence across reconnects and a follow-up turn when answering after completion. Implement that distinction in recovery, run terminalization, thread settlement, historical queries, and client projections. Unanswered groups must survive history pagination without retaining or replaying unbounded work logs.

### A4. Pending questions currently take over normal composition. P1 for the accepted interaction

[ChatView](../../apps/web/src/components/ChatView.tsx:2736) chooses the first pending group. Its composer handling at lines 6726, 7601, and 8065 routes composition through the active question. [ComposerPendingUserInputPanel](../../apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx) offers a collapsible question panel, not an independent question button and anchored picker.

Corey selected a Codex-like question button that opens a picker near the composer. Normal chat remains available while the agent works. Store question drafts by stable group and question identity. Opening, dismissing the popup, switching threads, and receiving streaming text must not submit an answer or steal a draft. Selecting an option is separate from submitting.

The existing [pending request selector](../../packages/client-runtime/src/state/threadRequests.ts) joins typed request entities to display items. Preserve this V2 design instead of importing T3's activity-history reducer wholesale.

### A5. Blocking-question metadata and provider cancellation are incomplete. P2, confirmed source gaps

The installed CLI schema exposes isBlocking and deprecates autoResolutionMs. Pathway intentionally accepts older messages without isBlocking, but [buildUserInputRequestArtifacts](../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:3295) drops that field as well as isSecret and isOther. The V2 question contract cannot carry these semantics. The shared selector also forces multiSelect=false.

At the audit baseline, the active V2 adapter registered no serverRequest/resolved handler. Its native request reference is payload.itemId rather than the JSON-RPC request id. The client handler API currently receives decoded params without the envelope id. The implementation update above records the new envelope-id correlation and focused verification.

Do not mistake isBlocking=false on the RPC question format for the distinct async agentMessage format. Test both, including older payloads without isBlocking. Preserve exact answer identifiers and permitted custom-answer behavior. Secret answers need masked entry and an explicit retention policy.

### A6. Resolved does not currently prove provider delivery. P2, confirmed failure-path risk

[Orchestrator.dispatchRuntimeRequestRespond](../../apps/server/src/orchestration-v2/Orchestrator.ts:5600) marks the request, node, and item resolved before the delivery effect runs. [EffectWorker](../../apps/server/src/orchestration-v2/EffectWorker.ts:609) retries and eventually fails that effect without reopening the request in this path. The card may disappear even when delivery fails. Codex answer conversion filters unrecognized question ids but does not validate that every required answer exists before resolution.

The async implementation needs separate accepted, pending-delivery, delivered, and failed outcomes, or an equivalent small receipt-based model. Keep drafts on failure, prevent a second device from submitting the same group twice, and make a retry reuse the same durable answer. Test provider acknowledgement uncertainty as well as outright connection failure.

### A7. Astra is classified as legacy, and this CLI does not advertise it. P1 for rollout, confirmed

[CodexProvider](../../apps/server/src/provider/Layers/CodexProvider.ts:68) has a fixed current-model set without Astra. Model discovery itself pages through model/list. [ModelPickerContent](../../apps/web/src/components/chat/ModelPickerContent.tsx:383) folds legacy models into a separate section. Astra would be classified incorrectly even when a provider advertises it.

The default CLI probe also did not return Astra. Verify each configured provider instance's binary, home, account, and live catalog before claiming availability. Display a useful update/access state when missing. Do not claim a hosted manifest grants access.

Default selection remains an open product decision. Current chat preference is Sol then Terra; title and utility generation uses Luna. An Astra release should not change those utility workloads implicitly.

### A8. Model options need runtime-specific validation. P2

Pathway maps supported reasoning and service tiers from model/list, which is the right source for a CLI-backed provider. The API reference lists low through max; it does not establish every Codex account's options. The migration guide excludes none and recommends moving minimal to low. EU data residency restricts Astra fast processing.

[appendCustomCodexModels](../../apps/server/src/provider/Layers/CodexProvider.ts:239) borrows capabilities from the first discovered model. That is not evidence of Astra capabilities. [buildCodexTurnStartParams](../../apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts:630) validates the protocol effort enum but does not itself validate against the selected model's advertised choices. Check saved selections, custom entries, model changes, presets, background tasks, and native iOS sends before release. Do not silently advertise unsupported effort or speed settings.

Pathway delegates inference to Codex. API changes involving temperature, Responses tool calling, cache options, configuration_update, and WebSocket steering belong to that runtime unless Pathway adds a direct API provider. Updating this client does not justify rewriting the provider architecture.

### B1. Browser automation needs an attached desktop host. P1 scope constraint, confirmed

[PreviewAutomationHosts](../../apps/web/src/components/preview/PreviewAutomationHosts.tsx:284) registers only in Electron with the automation bridge. [PreviewAutomationBroker](../../apps/server/src/mcp/PreviewAutomationBroker.ts:526) routes by environment, provider session, connection, and tab. A browser-only client or native iOS app is not an automation host.

Remote agents can control a connected desktop's browser, subject to its network reachability. This is different from running Chromium beside a remote server or streaming it to a mobile client. Corey has now explicitly required independent web and iOS browser use with no connected desktop. A browser host outside Electron and authenticated presentation/input transport are therefore required. Chromium beside the agent environment is the recommended design to investigate; desktop participation and profile/lifetime policy remain open. Do not call browser-only or iOS automation ready based on desktop tests.

### B2. Remote environment ports lack a gateway; explicit loopback URLs are rewritten. P1, confirmed

[browserTargetResolver](../../apps/web/src/browser/browserTargetResolver.ts:67) explicitly throws when an environment-port target needs the planned authenticated preview gateway. Replacing a hostname with a private network address does not make a server bound only to remote loopback reachable. The same file rewrites explicit loopback URL targets, which can send a user-entered URL to a different machine than intended.

Define literal URL versus environment-port intent. Implement an authenticated path for remote loopback applications through Pathway Connect, or host Chromium where the application runs and transport its presentation. Include cookies, redirects, WebSockets, assets, and disconnect behavior in the design. Do not expose dev servers publicly as a shortcut.

### B3. OAuth popup handling breaks opener-based flows. P1, confirmed source defect

[Preview Manager](../../apps/desktop/src/preview/Manager.ts:1303) denies every window.open request, redirecting nonblank destinations into new tabs. OAuth SDKs expecting a real popup and opener callback cannot rely on that. [HostedBrowserWebview](../../apps/web/src/browser/HostedBrowserWebview.tsx:110) sets allowpopups in a ref callback, which T3 fixed because it can be too late at guest attachment.

Adapt the upstream popup fix while retaining Pathway's tab behavior. Test a real local popup/opener/postMessage round trip, closure, failure, and session sharing. Decide whether agent automation can inspect popup contents or asks the user to finish sign-in. The current preview tools address tabs, not arbitrary native windows.

### B4. The debugger wrapper lifetime has a relevant upstream crash fix. P1 candidate, source pattern confirmed

[Preview Manager](../../apps/desktop/src/preview/Manager.ts:887) repeatedly accesses wc.debugger and does not retain the wrapper in BrowserControlSession. T3's September 3 fix retains it for the control session and uses that reference for cleanup after WebContents destruction. Pathway contains the old pattern.

Adapt this small lifecycle fix and validate teardown, navigation, crash recovery, and recording. The reported native crash was not reproduced in this audit. Pathway pins Electron 41.5.0; T3 also has Electron 43-specific recording changes, which should not be copied without checking version applicability.

### B5. Screenshot and input coordinate systems are underspecified. P2, confirmed contract gap

[captureAutomationSnapshot](../../apps/desktop/src/preview/Manager.ts:2574) reports element bounds in CSS pixels, captures an image, and resizes images wider than 1280. [PreviewAutomationSnapshot](../../packages/contracts/src/previewAutomation.ts:530) reports only the resulting image dimensions. It omits source dimensions, CSS viewport dimensions, device scale, and screenshot-to-input scale. The click path uses CSS coordinates.

Locator-based interaction avoids much of this mismatch. Screenshot-driven interaction needs an explicit coordinate contract and tests at Retina scale, browser zoom, responsive sizes, and wide windows. The tool set currently supports click/type/press/scroll/evaluate, not the entire native computer action set such as drag and arbitrary desktop control. Native app control is deferred by user decision.

### B6. Browser payload size and hidden rendering need focused performance work. P2

Every preview_snapshot collects page text, interactive elements, the complete AX tree, diagnostics, action history, and a PNG. Some collections are bounded, but the AX tree has no explicit response budget here. [McpHttpServer](../../apps/server/src/mcp/McpHttpServer.ts:581) correctly returns the screenshot as an image block rather than embedding it in text JSON.

The browser has per-control-session serialization, bounded action history, provider-session host affinity, and a takeover fence. Preserve those. Each coordinate click currently adds 160ms plus 40ms for cursor presentation. Hidden guest rendering and duplicate PiP frames have relevant upstream improvements. Measure idle CPU, streaming payload bytes, snapshot size, and action latency before introducing high frame rates or more screenshots.

### B7. Browser profiles and human-control UX are separate product work. P2 candidates

Pathway has persistent partition derivation but no equivalent of T3's named browser profiles and import wizard in the audited files. Profiles are useful for repeat sign-in and work/personal separation. Cookie import adds OS-specific native code, packaging, and account-selection behavior. It is not a prerequisite for model discovery or async questions.

Pathway already has a durable [browser takeover service](../../apps/server/src/orchestration-v2/BrowserTakeoverService.ts), fencing, restart recovery, and continuation. Preserve it while deciding how normal clicks, closing a tab, hiding a panel, and returning control interact. Treat background browser visibility and user-chosen panel state as different from whether automation is allowed to continue.

### B8. Astra favors a persistent browser coding interface; existing MCP tools remain supported. Design opportunity

OpenAI recommends code execution for Astra computer use, with a persistent environment and bounded execution. Its guide explicitly permits keeping existing function or MCP UI tools. Pathway therefore does not need to replace its preview toolkit to claim basic compatibility.

Pathway's preview_evaluate runs JavaScript in the page. It is not a persistent Playwright controller where a script can compose browser actions, loops, and observations. A future browser script tool could reduce separate model/tool round trips, but must call through the same tab ownership, cancellation, takeover, and environment routing rules. It must not create a second uncontrolled browser beside the one the user sees.

Recommendation: fix the current host and remote routing first, then compare a small persistent browser scripting interface against the existing tools on representative tasks. Native desktop scripting remains outside this release's agreed scope. Exact OpenAI Responses computer-tool action schemas do not need to be added to Pathway's wire contract while Codex and MCP remain the execution path.

## Upstream changes to adapt

Dates below follow the commit timestamps. Follow each link for the exact change reviewed.

| Change | Evidence | Recommendation |
| --- | --- | --- |
| Remote classification manifest, August 25 | [badae6a5, #8227](https://github.com/pingdotgg/t3code/commit/badae6a5cc8325dcd5a145bea6f7b8ac692818a1) | Adopt the mechanism with a Pathway-owned source. Preserve live runtime discovery. |
| Claude catalog from manifest, September 1 | [03542836, #9084](https://github.com/pingdotgg/t3code/commit/03542836834d008a097450cf24d0d9c6f965b859) | Consider a later extension; broader than Astra classification. |
| Async questions, September 3 | [d76b24dd, #9512](https://github.com/pingdotgg/t3code/commit/d76b24dd15a219666941ab1b4967d8f738adcda0) | Adapt notification mapping, message replies, persistence, and race tests to V2. |
| Astra current classification, September 4 | [bc03c364, #9762](https://github.com/pingdotgg/t3code/commit/bc03c3640d6d3bb44e5fb477bfd78d7484cd0e00) | Include in initial manifest. This commit alone is not async support. |
| Completed requests remain closed, September 6 | [e63ddb48, #10123](https://github.com/pingdotgg/t3code/commit/e63ddb48e2fd23854a0b4a480b32cbf33e601981) | Reuse lifecycle cases, not the older activity-reducer architecture. |
| OAuth popups, August 28 | [0e2905eb, #8435](https://github.com/pingdotgg/t3code/commit/0e2905eb783fd2385f358a95f0b25bbf07ff7122) | High-value browser fix. Adapt to Pathway tab ownership. |
| Retain debugger wrapper, September 3 | [6319a971, #9068](https://github.com/pingdotgg/t3code/commit/6319a9714881a1d25549f797c468fabebae92813) | High-value lifecycle fix; native crash proof still required. |
| Hidden previews and duplicate updates, August 28–29 | [ff176101, #8567](https://github.com/pingdotgg/t3code/commit/ff1761012af46ceb5f1ecc9b2be00aae288a1691), [72c44a84, #8018](https://github.com/pingdotgg/t3code/commit/72c44a847c0a76f33b0d21f47548125b7032ec35) | Adapt with automation, recording, and PiP exceptions. |
| Recording quality and Electron 43 corrections | [39581110, #8839](https://github.com/pingdotgg/t3code/commit/3958111057c10c10350dd9c20ec2a2df00f504be), [ef7014d8, #9001](https://github.com/pingdotgg/t3code/commit/ef7014d851f56bb037a9da963095ffd883c7fa08) | Review as a sequence. Version-specific; avoid an incidental Electron upgrade. |
| Profiles and empty-panel launcher, September 2 | [134d5109, #7254](https://github.com/pingdotgg/t3code/commit/134d51096ea0d00a53a499e8f0c87e31fafb0006), [064392ff, #9279](https://github.com/pingdotgg/t3code/commit/064392ff) | Product decision. Keep browser identity on its owning host. |
| Cookie import and follow-up fixes | [39449e53, #7255](https://github.com/pingdotgg/t3code/commit/39449e53e31a56103192aa7905e89fc92c977a4a), [3653cb22, #9516](https://github.com/pingdotgg/t3code/commit/3653cb22ffb30bf133fecc30c955941fe267cf1c), [c2cfe59a, #9797](https://github.com/pingdotgg/t3code/commit/c2cfe59ac356768deb2a7d3e3461c715aa50a7a1) | Separate optional work. Bring review fixes and lazy discovery together if selected. |
| Agent preview visibility, September 3 | [12e8997e, #9484](https://github.com/pingdotgg/t3code/commit/12e8997e58dbca8f1bd8c63b67d662eb69cf0e0d) | Adapt to Pathway's existing reveal and takeover logic; do not overwrite explicit hidden state. |
| Closing an agent-controlled browser | [28ddaf75, #9272](https://github.com/pingdotgg/t3code/commit/28ddaf75917140e5e4355d4386bc5d14d9dad7b6) | Reconcile with Pathway's takeover and close semantics. |
| Literal URLs versus discovered server URLs | [098bf532, #8902](https://github.com/pingdotgg/t3code/commit/098bf5329727fcd7d973bf842e6b4d50d6e7b924) | Adapt intent separation while designing Connect routing. |
| Preserve manual panel choices, September 6 | [bccad270, #10113](https://github.com/pingdotgg/t3code/commit/bccad270466a039e254167b1b4da06e344d750a4) | Reuse user-choice revision principle when integrating automatic browser reveal. |

T3's current [ModelManifest service](https://github.com/pingdotgg/t3code/blob/ea646c0834a3394ecb0be4a30c5d367e5a9002bd/apps/server/src/provider/ModelManifest.ts) reads a bundled fallback and validated disk cache, refreshes in the background, uses a one-hour TTL and five-minute failed-attempt gap, bounds fetches at ten seconds, serializes refreshes, and respects provider-update-check settings. It compares bundle and cache edit dates. Its later provider catalogs include defaults, profiles, aliases, and adapter metadata. These should not all become first-release requirements merely because upstream supports them.

Pathway ownership is accepted. Recommend a versioned data file with last-good fallback and nonblocking refresh. Keep account access, supported model options, and executable adapter behavior authoritative in the provider. Decide explicit legacy versus unknown classification rather than automatically demoting every newly discovered slug.

## Client, provider, and connection coverage

| Area | Audit result and implementation obligation |
| --- | --- |
| Web and desktop chat | Shared web picker and question popup need the new message reply contract. |
| Native iOS | This checkout contains apps/pathway-ios, not the React Native app described in AGENTS.md. It has inline question cards and live-request checks. Port contract and lifecycle behavior to Swift, including reconnect and answer failure. |
| Android | No Android or React Native client exists in this checkout's apps directory. Locate its repository or explicitly exclude it before claiming parity. |
| Settings, model shortcuts, presets | Consume provider model snapshots and saved selections. Verify custom models and default behavior at every entry point. |
| Native subagents | Bind the question to its original provider thread and define where its answer UI appears. Do not steer the root by default. |
| Codex | Runtime catalog, async agentMessage, RPC questions, steering, approvals, and MCP browser path apply. |
| Claude, Cursor, Grok, OpenCode, ACP registry | Preserve their adapters and existing question replies. Shared contracts need compatible defaults. A model slug alone does not add Astra support to a different provider. |
| Local desktop | Existing Electron browser host can execute preview tools. Needs real popup, coordinate, lifecycle, and rendering validation. |
| Remote agent with connected desktop | Broker routes to desktop host. Browser-side and server-side localhost are distinct. |
| Connect or tunnel | Arbitrary environment-port navigation is not implemented by the current URL resolver. A remote transport design is required. |
| Browser-only or native iOS without desktop | No registered browser automation host was found. Requires a hosted browser option or an explicit availability boundary. |
| Reverse actions | Answer, dismiss popup, dismiss group, retry failed answer, clear stale request, return browser control, close tab, and reconnect all need defined behavior. |
| Docs and alerts | Shipped user docs follow implementation. Update attention wording so a running agent with a question is not described as stopped. |

## Verification performed

All checks used existing focused tests. No repo-wide suite, browser, simulator, development server, live Pathway database write, or model generation was run.

| Package | Explicit test files | Result |
| --- | --- | --- |
| Server | CodexProvider, codexModelOptions, CodexAdapterV2, ProviderRuntimeRecoveryService, PreviewAutomationBroker, preview handlers, BrowserTakeoverService | 7 files, 165 tests passed |
| Web | pendingUserInput, ComposerPendingUserInputPanel, modelSelection, browserTargetResolver, browserSurfaceStore, previewAutomationOpenReadiness, previewAutomationReveal | 7 files, 64 tests passed |
| Desktop | preview Manager, BrowserSession, PreviewKeyboard | 3 files, 47 tests passed |
| Codex protocol package | protocol, client | 2 files, 13 tests passed |
| Total | 19 files | 289 tests passed |

Commands used vp test run with only those named files from each package directory. The web and desktop checks were unit tests, not visual proof. The protocol was also generated into a temporary directory from the installed CLI and compared without overwriting repository-generated files.

## Required proof before calling the release ready

1. Replay real async-question wire events through the V2 adapter. Prove one card, continued streaming, and no false turn completion.
2. Submit while running, during completion, and after idle. Prove one durable answer and correct steer or resume behavior. Include native subagents and provider changes.
3. Exercise reconnect, server restart, duplicate events, two-device answers, invalid answers, and failed delivery. Use receipts and worker drains.
4. Verify popup geometry, normal composer availability, keyboard flow, free text, pending count, answered history, and retained drafts in web/desktop and native iOS.
5. Probe Astra on the intended provider instances and run a small real task only once that runtime advertises or otherwise verifies access. Validate effective effort and tier.
6. Exercise browser OAuth popup, navigation, redirect, downloaded/uploaded file behavior, screenshot coordinates, zoom, hidden state, tab close, takeover, host reconnect, and provider cancellation.
7. Prove remote loopback HTTP and WebSockets through the chosen Connect design, from a second machine. Local mocks do not establish this.
8. Measure idle CPU, PiP updates, recording, screenshot payloads, and action latency on the supported Electron version.

## Decisions and next step

Accepted so far: a question button opens a picker near the composer; normal chat remains available; unanswered questions survive reconnects; an answer after completion starts a follow-up in the same task; web and iOS must use the remote browser without a connected desktop; the remote model manifest is Pathway-owned; native app control is deferred.

See [the design record](../adr/0014-astra-questions-and-browser-scope.md) for the decision log and remaining interview questions. Corey subsequently authorized implementation; remaining choices and validation boundaries are tracked in that record.
