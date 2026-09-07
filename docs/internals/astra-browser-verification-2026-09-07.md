# Astra and browser implementation verification

Worktree: `codex/astra-browser-integration`, based on `b58238754375e8db0d6321526bca366582f89d86`. Changes are uncommitted. No production deployment, Git push, or pull request was requested.

## Implemented scope

- Pathway-owned current/legacy model manifest, bundled fallback, last-good cache, bounded remote refresh, provider-discovered capabilities, and preserved model defaults. Cached model options validate saved effort and service-tier settings before Codex turns.
- Durable asynchronous Codex questions with independent blocking/transport metadata, explicit client submission, origin-aware routing, reconnect/recovery handling, cancellation correlation, and definite steer-to-follow-up fallback.
- Web and native iOS question pickers, environment browser frames/input/tabs/captures/takeover, and desktop host selection.
- Environment-owned Chromium profiles, popup ownership, bounded serialized actions, frame coalescing, disk-streamed H.264 recording, and signed HTTP media ranges.
- Selected T3 desktop fixes for debugger lifetime, capture bounds, popups, keyboard isolation, PiP updates, annotations, and recording quality/limits.
- Account-owned encrypted password vault with owner/origin/revision checks, explicit autofill, management UI, and signed macOS device-bound Touch ID setup.

## Focused evidence

Test counts overlap across reruns. Do not sum them as independent coverage.

| Area                            | Evidence                                                                                                                                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Async backend                   | 82 focused tests; active reply, idle follow-up, rejected-steer race, replay/idempotency, cancellation, native child reply                                                                                                                                                              |
| Codex protocol                  | 13 focused tests, including exact JSON-RPC envelope identity                                                                                                                                                                                                                           |
| Browser host selection/takeover | 93 focused tests                                                                                                                                                                                                                                                                       |
| Model metadata/options          | Manifest/provider tests and 64-test options/adapter/replay pass                                                                                                                                                                                                                        |
| Web/client runtime              | 66 web tests and 255 selected shared tests, plus focused regression reruns                                                                                                                                                                                                             |
| Vault                           | 7 encryption/ACL/revision/backend tests; backend package typecheck                                                                                                                                                                                                                     |
| Desktop                         | 77 selected desktop tests, 16 recording tests, 7 autofill tests; desktop package typecheck with existing suggestions                                                                                                                                                                   |
| Native iOS                      | 15 selected conversation tests plus 4 RPC subscription tests on iPhone 17/iOS 26.3; normal simulator signing builds successfully and reaches the login screen. The newest-frame overflow regression passes while lossless conversation overflow still requires reconnect               |
| Remote runtime lifecycle        | 12 focused tests, including metadata coalescing, ownership, limits, and reading a saved recording after its tab closes                                                                                                                                                                 |
| Real Chromium                   | Loopback fixture proves lazy subscription, frame delivery, selected-login fill without submission, origin rejection, popup opener, blank popup navigation, PNG, H.264 MP4 with elapsed-duration assertion, and tab closure                                                             |
| Browser RPC permissions         | Focused tests reject unauthorized commands/subscriptions before invoking the browser and disable tracing for credential-bearing commands                                                                                                                                               |
| HTTP media                      | Real route test proves 206 headers/body, 416 bounds, and rejection of altered asset tokens; pure parser cases cover bounded/open/suffix ranges                                                                                                                                         |
| Live model picker               | GPT-6-Astra shown in the real development client; GPT-5.6-Sol remains default                                                                                                                                                                                                          |
| Live account vault              | Synthetic login saved through Settings against isolated Convex; metadata remains visible after a full client reload                                                                                                                                                                    |
| Live Astra question             | Real CLI turn completed with a pending Blue/Green question retained across restarts. Authenticated typed RPC submitted Blue after completion; Astra answered “Blue selected.” in the same task. Retrying the identical command returned the same receipt with no extra message or turn |

Primary verification uses `.pathway` state, a separate anonymous local Convex deployment under `.pathway/convex-verification`, and simulator `975A195C-378F-425A-A390-D1CEE269C720`. The shared Convex development deployment was older than this checkout and was not changed. The local deployment uses a dedicated random vault key and the existing development Clerk issuer. No production state or credentials were copied.

The initial unsigned simulator build compiled but failed Clerk Keychain startup. Normal simulator signing fixes that launch boundary. Keep compiler/test evidence separate from authenticated native browser proof.

## Live client boundary

The live Astra test created task `d27ae3b9-5971-4773-83bb-9c0c2ea1e843` and completed its turn. Direct launch succeeded. The development UI remained on its draft because company-scoped task visibility requires a cloud replica, while this isolated environment is not linked to the relay. It cannot publish that replica. This is an incomplete integrated UI proof, not a failed Astra turn. No shared deployment or live environment was changed to work around the link.

The late-answer protocol proof uses the normal CLI pairing, authenticated browser session, single-use WebSocket ticket, and typed RPC client. Its receipt is sequence 54; runs increased from one to two, with one saved answer and the request resolved. The sanitized result is retained at `.pathway/async-answer-proof.json`; `apps/server/scripts/verify-async-question.ts` is the explicit opt-in verifier.

The question picker has focused component/native tests; authenticated native browser interaction and the full company-linked browser/question flow remain to be verified. The latest signed simulator build includes the final native browser metadata changes and reaches the login screen.

## External and remaining boundaries

Apple's arbitrary-site browser passkey entitlement needs Account Holder approval and a native browser-specific AuthenticationServices bridge. The implemented Touch ID authenticator is device-bound, does not synchronize through iCloud, and does not expose existing Apple Passwords entries. See the [Apple runbook](../operations/browser-passkeys.md).

Native Electron OAuth popup windows preserve opener/session but are not agent-addressable tabs. The environment browser supports agent-addressable popup pages. Real signed-device biometric and Electron popup interoperability still need validation.

Browser host preference is process-local and must be selected again after a server restart. Browser profiles persist; live tab processes do not survive server shutdown. A provider accepting a question reply immediately before its process crashes remains an external acknowledgement ambiguity, exposed as a retry instead of an exactly-once promise.

Production activation requires publishing the manifest, deploying the vault schema/functions and secret keyring, and installing Chromium/FFmpeg on browser-hosting environments. None of those production actions occurred during this implementation.

## Retained local evidence

The final real-browser script passed with output in `/tmp/pathway-browser-live-proof-final.log`. Its temporary evidence directory is `/var/folders/9_/bvcp9xtj087f57t7b4z1yhnw0000gn/T/pathway-browser-proof-yAtMYK`. It contains the PNG and MP4 from the synthetic fixture; rerun the opt-in script to produce fresh artifacts.

The final model/HTTP subset passes 19 tests in four files (`/tmp/pathway-final-assets-models-tests.log`). The normal signed native build log is `/Users/coreybaines/Library/Developer/XcodeBuildMCP/workspaces/pathway-bab91144fc1c/logs/build_run_sim_2026-09-07T03-22-38-413Z_pid86744_5b421388.log`.

Final server package typecheck passes after the RPC authorization and verification-script changes (`/tmp/pathway-live-script-typecheck.log`). The four native subscription tests passed in `/Users/coreybaines/Library/Developer/XcodeBuildMCP/workspaces/pathway-bab91144fc1c/logs/test_sim_2026-09-07T03-25-36-013Z_pid86744_d2f216cd.log`. The worktree development server and separate local Convex process are retained for review; their state remains under `.pathway`.

## PR85 review follow-up

The published PR was updated after merging main at `1d62a8412`. All five review findings were confirmed and addressed: queued browser action deadlines, hosted web/iOS host selection, synchronous prevention of default WebAuthn account selection, durable capture indexing, and deleted-task browser cleanup. The native merge preserves main's synchronized requests, transport deadlines, and unified cloud lifecycle.

Focused verification passed: 21 runtime lifecycle tests, 5 deletion-service tests, 11 web preview tests, 4 desktop WebAuthn tests, and 23 native conversation/subscription tests. Scoped server/web/desktop typechecks pass; desktop retains two existing suggestions. No repository-wide checks were run. Native results are in `/Users/coreybaines/Library/Developer/XcodeBuildMCP/workspaces/pathway-bab91144fc1c/result-bundles/test_sim_2026-09-07T04-43-51-541Z_pid86744_97475b0e.xcresult`.

The model-picker and password-vault screenshots were uploaded to the PR's FileStore group. The Apple Passwords and linked-environment UI boundaries above remain unchanged.
