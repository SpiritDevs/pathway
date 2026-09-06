# Apple client simulator verification

Verified on 6 September 2026 on `codex/mobile-parity-completion` after the user authorized simulator and browser interaction. Scope: iOS, iPadOS and visionOS; Android is excluded. The implementation remains uncommitted. No deployment, Git publication or store submission occurred.

## 7 September follow-up: orientation and keyboard

The user selected portrait-only iPhone behavior. Both Debug and Release now declare portrait for iPhone, with a portrait base Info.plist entry and the existing all-orientation iPad override. The rotation test asserts the correct device-specific behavior again after opening and closing Calendar/Email editors, so an unchanged initial frame cannot satisfy the phone check alone.

The iPad keyboard failure was a Simulator input configuration issue. Outside XCTest, both title and search fields accepted input with no software keyboard. Turning off the selected iPad's **I/O → Keyboard → Connect Hardware Keyboard** immediately displayed the keyboard. The persisted per-device `ConnectHardwareKeyboard` value is now false. The original picker test then passed unchanged, including multi-selection and draft persistence. An explicit pre-typing software-keyboard assertion now explains this prerequisite; product focus code did not change.

Final focused checks pass on both devices: two iPhone portrait/picker tests and two iPad rotation/picker tests, including the stronger software-keyboard precondition. There are no failures or diagnostics in either final run. Existing visionOS compilation inputs still match all 147 recorded hashes; no visionOS runtime is installed, so spatial runtime validation remains unavailable.

## Environment and proof

- Xcode project `apps/pathway-ios/Pathway.xcodeproj`, scheme `Pathway`, Debug, arm64; derived data `.pathway/build/ios-parity`.
- iPhone 17 Pro, iOS 26.3.1: `1EF49E1D-C462-4C24-A073-99F0D8369A8A`, already booted before verification.
- iPad Pro 13-inch (M5), iOS 26.3.1: `88D197CA-9BAD-4986-96B7-BD0D74F04994`, booted for this run.
- Test builds use a temporary development configuration. The built app was verified to contain a Clerk development key; the original ignored native configuration was preserved and its SHA256 rechecked. Fixture launch arguments bypass authentication and exercise real SwiftUI screens with deterministic injected models, without live service writes.
- Simulator ad-hoc signing is enabled. Unsigned real app startup failed in Clerk Keychain with `OSStatus -34018`; ad-hoc signing resolved startup. The native CI script now uses the same signing mode for simulator tests.

## Results

| Scope                                  | Result                                                                                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native model and contract target       | **202 passed**, no failed/skipped tests in the final signed run. The image decoder emitted an expected diagnostic for the invalid-image rejection test; its assertions passed.                        |
| iPhone Conversation and Issues         | **All 17 workflows passed**, including the corrected drag crash and final unchanged property-picker assertions.                                                                                       |
| iPhone Calendar/Email parity           | **All six workflows passed**, including the final retention/analytics recheck with keyboard-aware scrolling.                                                                                          |
| iPhone largest Dynamic Type            | Passed: rendered row/title growth, Calendar menu, reachable Cancel with keyboard, edits and new drafts cancelled without mutation.                                                                    |
| iPhone rotation                        | **Passed under the requested portrait-only policy.** Device rotation retains portrait and reachable Calendar/Email actions.                                                                           |
| iPad Conversation                      | **All six workflows passed.**                                                                                                                                                                         |
| iPad Issues                            | **All 11 workflows have passed.** Picker keyboard assertions pass with the Simulator hardware keyboard disconnected; see the follow-up above.                                                         |
| iPad Calendar/Email parity             | **All six workflows passed**, including Calendar CRUD/denied writes, read/unread/offline failure, tag CRUD, retention persistence and analytics.                                                      |
| iPad rotation and largest Dynamic Type | **Both workflows passed** after the sidebar/menu readability fix. Portrait/landscape retain the destination and its actions.                                                                          |
| visionOS                               | Full Swift 6 module emission passes against XRSimulator 26.2 with real Clerk, 147 inputs and no diagnostics. Missing platform/device-type component prevents full packaging; no runtime is installed. |

Each device has 25 selected UI workflows. The two previously failing workflows are resolved by the requested iPhone portrait policy and the corrected iPad Simulator keyboard configuration. Counts describe distinct workflows and focused final reruns, not a single all-green end-to-end suite. No repo-wide test or typecheck was run.

## Product fixes verified

**Issue-board drag crash.** Foundation invoked an `NSItemProvider` callback off-main, but inferred MainActor isolation trapped before the explicit actor hop. Provider callbacks now declare `@Sendable`, and actor-bound completion is delivered on MainActor. Two real provider regression tests pass; board reordering and status movement pass on both devices.

**Largest-text iPad sidebar.** Context navigation widened at accessibility sizes, with text-only context labels. Calendar uses a menu at those sizes instead of compressing large labels into a segmented control. Rendered text growth and readable sidebar words are asserted, and the resulting screenshots were inspected.

**Accurate notification copy.** Calendar reminders are saved for desktop alerts, but native delivery is not implemented. Email capture banner settings configure desktop behavior. Native copy now states these boundaries instead of promising alerts on this device.

## Test corrections and original keyboard diagnosis

The iPad board-drop target was corrected to the visible column midpoint; the old edge coordinate missed after horizontal scrolling. Related navigation now uses its shared accessible label instead of a phone-only identifier. The keyboard test no longer assumes a key named “space”; it verifies real search input and retains its software-keyboard assertions.

Email retention initially looked like a numeric binding bug. Recordings showed that keyboard dismissal moved the modal and the test missed Save. Original numeric fields correctly persist `321`; speculative numeric-form changes were reverted. Test gestures and waits now target actual visible forms/lists. Analytics uses the combined accessibility label “Average, 42 ms”.

The initial iPad property-picker test failed its software-keyboard assertion before input. A temporary diagnostic proved that search retained focus and accepted typing without refocusing. This was left unresolved in the 6 September report. The 7 September follow-up established the hardware-keyboard connection as the cause and passed the original assertions after disconnecting it. Speculative product focus/hit-testing changes were not retained.

The long-press menu test passed on both devices but takes about 251 seconds because XCTest repeatedly waits for menu animations. This is a test synchronization limitation; no measured app-performance conclusion follows from it.

## Remaining implementation work

1. Native company-owned Integrations management is missing. Current native Slack intake uses environment-local token/watch RPCs; desktop has company ownership, primary/backup controllers, activation/health, V2 routing and shared automation.
2. Native Calendar reminder delivery needs account-scoped scheduling, deduplication, routing and cancellation after edits/deletion/signout. Saved reminder settings alone do not deliver alerts.
3. Native captured-email banners need a cross-route notification host, source preference/mute handling, deduplication and Open-message routing.

These are separate from deployment and device verification. See the [completion ledger](mobile-parity-completion.md) for source pointers and the broader implementation.

## Live services and device gates

The real development app started successfully and displayed Clerk’s hosted development sign-in page. The simulator accessibility bridge did not expose its browser fields; no credentials were entered and sign-in was not completed. Development Clerk, relay health/JWKS and Convex endpoints were checked read-only.

Fixture tests do not prove authenticated Convex subscriptions, relay reconnection, real provider execution, cross-device persistence or production attachment transfer. Backend and relay changes remain undeployed; native GitHub CI has not run remotely.

Physical devices still need signing/App Group checks, share-extension handoff, universal links, APNs and Live Activity delivery, VoiceOver, hardware keyboard/IME, iPad multitasking and sustained performance measurement. visionOS still needs the missing platform component, a packaged build and runtime verification. No platform downloads were performed.

## Evidence

Full result bundles and logs are under `/Users/coreybaines/Library/Developer/XcodeBuildMCP/workspaces/pathway-6d695be6fd16/`. Selected bundles:

- 7 September final iPad rotation/picker: `test_sim_2026-09-06T20-22-17-626Z_pid90839_5e07d257.xcresult` (two passed with final metadata and precondition).
- 7 September iPhone portrait/picker: `test_sim_2026-09-06T20-20-03-484Z_pid90839_16a430be.xcresult` (two passed).
- 7 September iPad original unchanged picker and rotation: `test_sim_2026-09-06T20-18-01-613Z_pid90839_e54851f8.xcresult` (two passed).
- Final iPad retention/analytics: `test_sim_2026-09-06T11-17-54-327Z_pid86771_ef864193.xcresult` (one passed).
- Final iPhone retention/analytics: `test_sim_2026-09-06T11-15-53-416Z_pid86771_d65546ab.xcresult` (retention passed; rotation still failed).
- Final signed native target and iPhone accessibility: `test_sim_2026-09-06T11-05-22-153Z_pid86771_542dc8ce.xcresult` (202 native plus one layout pass; rotation failed).
- Final iPhone board/picker/related: `test_sim_2026-09-06T11-09-09-655Z_pid86771_e5111e4a.xcresult` (three issue flows pass; retention gesture failed).
- iPad accessibility/rotation and retention: `test_sim_2026-09-06T10-53-16-313Z_pid86771_5bfac49c.xcresult` (three pass; picker keyboard fails).
- iPad Conversation: `test_sim_2026-09-06T10-27-49-689Z_pid86771_dec59317.xcresult` (six pass).
- iPad long-press: `test_sim_2026-09-06T10-43-13-375Z_pid86771_6a603bad.xcresult` (one pass).
- Final isolated iPad picker check: `test_sim_2026-09-06T11-04-24-228Z_pid86771_5557a6da.xcresult` (failed; unsuccessful candidate reverted).

Exported screenshots and recordings are in `.pathway/evidence/apple-client-simulator/`:

- `ipad-final-layout/16D1D61C-5EA8-4D8B-98C9-E5D6C35DFD27.png`: corrected largest-text sidebar.
- `ipad-final-layout/671CBBE3-CEA3-40C4-9150-14A4C02F2E2C.png`: verified landscape layout.
- `iphone-final-layout/34887F11-560D-44C4-83FB-63931A5FCDB2.png`: accessible editor with reachable Cancel and keyboard.
- `development-hosted-sign-in.jpg`: actual development hosted sign-in boundary.
- `vision-swift-module/`: exact command, source hashes, empty diagnostic log and exit code zero.

## Cleanup and final checks

The iPad simulator booted for this run was shut down; the pre-existing iPhone simulator remains booted. No development server was started. The original native configuration hash remains unchanged. Temporary diagnostic tests and unsuccessful focus, hit-testing, numeric-form and orientation changes were removed. Final scoped checks passed: `git diff --check`, native Info.plist validation and native CI script shell syntax. Final visionOS module emission completed after the copy corrections with 147 unchanged inputs, exit code zero and no diagnostics.

Follow-up keyboard screenshots: `.pathway/evidence/apple-orientation-keyboard/ipad/3A2CFCD3-5CCD-475E-8E43-9595E42C34EE.png` and `0FB25BF9-7E2E-4BA7-9F0A-E65ECC69D96B.png` show the visible keyboard in Assignee and multi-select Labels.
