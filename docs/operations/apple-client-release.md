# Apple client release verification

This version targets iOS, iPadOS and visionOS. Android is excluded. Code coverage and local compilation do not establish App Store readiness.

## Configuration and signing

1. Generate the ignored native public configuration with `node scripts/configure-pathway-ios.ts`. Use the intended Clerk, Convex and relay environment; never place private credentials in the app.
2. Register the app and extension identifiers from `apps/pathway-ios/Pathway.xcodeproj/project.pbxproj` with the Apple developer team. Enable the `group.com.spiritdevs.pathway.shared` App Group for the app, widget extension and share extension. Confirm signed entitlements match provisioning profiles.
3. Enable Push Notifications for the app. Debug uses the development APNs environment; Release uses production. Configure the relay's matching APNs team/key/topic credentials using the existing secret-management process.
4. Register the bundle identifier and App ID prefix in Clerk's native configuration. Verify the hosted authentication callback and associated domains on a signed device.
5. Serve the matching Apple App Site Association configuration for `app.pathwayos.dev` thread links and the configured Clerk domain. The checked-in entitlement alone cannot establish universal-link delivery.
6. Deploy the matching backend and relay changes: shared contacts/time tables, team restoration, and visionOS notification registration/delivery. Deploy source environment updates for remote pairing and revision-protected file writes. Older file servers intentionally remain read-only in the native editor.

## Build and fixture checks

- Install Xcode's iOS and visionOS platform components. The SDK directory alone is insufficient for the visionOS asset compiler.
- Run `node scripts/ios/build-terminal.mjs --check`; regenerate the checked-in Ghostty bundle when its tracked source changes.
- `scripts/ios/ci-check.sh iphone` and `ipad` build and run fixture tests on installed simulators. `visionos` builds the native simulator target. These scripts launch simulator testing and should only be used locally with permission.
- For software-keyboard tests, select the intended Simulator device and turn off **I/O → Keyboard → Connect Hardware Keyboard**. This is a per-device preference. Verify the keyboard appears before typing; XCTest typing can temporarily summon it even with hardware input connected, hiding a setup error. The issue property-picker test checks this precondition and preserves its keyboard assertions throughout selection.
- Unsigned simulator fixture tests bypass Clerk. For real development sign-in, keep simulator ad-hoc signing enabled so Keychain entitlements are available; an unsigned app can terminate during Clerk configuration with OSStatus -34018. Verify the built public key is `pk_test_` before unattended authentication. Use a temporary `-xcconfig` override to preserve an existing production `Config/Local.xcconfig`.
- Run the applicable native checks locally before pushing. The native GitHub workflow is manual-only (`workflow_dispatch`); pull requests do not automatically repeat iPhone, iPad or visionOS checks. When requested, the manual workflow runs those jobs on an Apple Silicon macOS runner.

## Integrated device verification

Use an isolated development environment and the provisioned Clerk development account. Keep fixture checks separate from actual cloud/relay/provider execution.

- iPhone and iPad: sign in, connect over LAN and relay, create a thread with files, receive approval/input, disconnect/reconnect, then finish Git/PR work. Check uncertain-write retry without duplicate work.
- Account changes: hold a sync/token request, sign out or switch accounts, and verify the previous account never returns. Check shared drafts, saved prompts, discovery and pending uploads.
- iPad: portrait, landscape, narrow split screen, keyboard navigation, external keyboard terminal input and file selection.
- iPhone: verify portrait is retained when the device turns sideways, including after opening and closing editors. iPad must continue to rotate normally.
- visionOS: cloud authentication/subscriptions, HTTP mutations, relay connection, approval handling, files/photos and App Intents in the real spatial shell. Camera/document scanner, share extension and ActivityKit are iOS-only.
- Notifications: opt in and out; verify attention, completion and failure events, correct thread links, token rotation, account changes, disabled preferences and signout. Verify foreground and background behavior on physical devices.
- Live Activities: verify the exact aggregate payload, push-to-start, updates, user dismissal, disabled activity preferences and end/signout cleanup. A simulator widget build cannot establish APNs delivery.
- Work-summary widgets: verify small/medium layouts, saved-count timestamps, navigation links, account replacement and signout. Confirm system-scheduled redraw on iPhone, iPad and visionOS.
- Share extension and Shortcuts: save text, URLs and files; review the draft; select a project; cancel/reopen; send once. No system entry should send a prompt without the user reviewing it.
- Accessibility/performance: VoiceOver, large Dynamic Type, reduced motion, light/dark contrast, long histories, many projects, terminal output volume and calendar overlap/resize. Record measured results rather than inferring them from compilation.

Record the build identifier, service versions, devices and results with the release. Production service deployment, App Store submission and publication require their own authorization.
