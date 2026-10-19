# Apple client release verification

This version targets iOS, iPadOS and visionOS. Android is excluded. Code coverage and local compilation do not establish App Store readiness.

## TestFlight workflow

[Release iOS to TestFlight](../../.github/workflows/release-ios.yml) archives the iPhone/iPad app,
widget and share extension, then uploads through Xcode's App Store Connect distribution flow.
It runs every three hours at minute 27 UTC, and can be started from GitHub Actions with
**Run workflow**. Manual runs always upload the selected branch or tag. The optional version
input overrides the marketing version for the app and both extensions for that run only.
Scheduled runs use the version in the Xcode project, so commit version changes there before
starting a new release series.

Scheduled runs compare the default branch with the `ios-testflight/latest` tag. Only changes
under `apps/pathway-ios`, `scripts/ios`, the native configuration generator, its public-config
helper, or the TestFlight workflow trigger an upload. The first scheduled run uploads if there
is no tag. Successful default-branch uploads advance that tag; failed uploads and releases
from other branches leave it alone. Skipped runs do not advance it. Allow GitHub Actions to
create and update this tag in repository rulesets. The workflow serializes all TestFlight runs
and lets active uploads finish.

The job uses the existing `production` GitHub environment and `FLEET_APPLE_RUNNER` labels.
Use a dedicated CI account with one job per host, Xcode 26.2 or newer, and the iOS SDK installed.
The workflow needs these environment or repository entries:

| Type               | Name                                                        | Value                                                                                                                    |
| ------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Secret             | `APPLE_API_KEY`                                             | Contents of the App Store Connect team API `.p8` key, as used by the desktop release.                                    |
| Secret             | `APPLE_API_KEY_ID`                                          | That key's ID.                                                                                                           |
| Secret             | `APPLE_API_ISSUER`                                          | The team's App Store Connect issuer ID.                                                                                  |
| Secret             | `IOS_DEVELOPMENT_CERTIFICATE`                               | Base64-encoded `.p12` containing an Apple Development certificate and its private key for the app's team.                |
| Secret             | `IOS_DEVELOPMENT_CERTIFICATE_PASSWORD`                      | Password used to export that `.p12`.                                                                                     |
| Variable           | `APPLE_TEAM_ID`                                             | The team that owns the app, currently `4444F36N8Z`.                                                                      |
| Variables          | `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_TEMPLATE`, `CONVEX_URL` | Existing production public app configuration. The Clerk key must start with `pk_live_`.                                  |
| Optional variables | `RELAY_DOMAIN`, `PATHWAY_WEB_LATEST_DOMAIN`                 | Relay and hosted app hostnames. Defaults match the native configuration: `relay.spiritdevs.com` and `app.pathwayos.dev`. |

Export the Apple Development identity from Keychain Access including its private key, then
encode it with `base64 -i certificate.p12 | pbcopy` when configuring the secret. The desktop
Developer ID certificate in `CSC_LINK` cannot sign the iOS archive. The script imports the
development identity into a temporary keychain and uses automatic provisioning for the app
and extensions. The team needs a registered development device for development profiles.
On exit, the script restores the original keychain search list, deletes its temporary signing
files/keychain, and removes newly downloaded provisioning profiles.

Use a team API key with the Admin role so Xcode can manage provisioning and use cloud-managed
distribution certificates. Existing desktop notarization access alone does not establish
these permissions. Register the identifiers and capabilities listed below and create the
`com.spiritdevs.pathway` app record in App Store Connect before the first run. Xcode signs the
archive for distribution in Apple's cloud and uploads it, including symbols. Xcode also
manages the uploaded build number to avoid collisions with previous CI or local uploads.
See [Apple's Xcode distribution automation guide](https://developer.apple.com/videos/play/wwdc2021/10204/).

A successful workflow means the upload finished. Apple still processes the build before it
appears in TestFlight. Enable automatic distribution on the intended internal TestFlight group
to deliver processed builds to its testers. External groups require assignment and any required
Beta App Review in App Store Connect. Resolve export-compliance questions there when prompted.
See [upload processing](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds)
and [internal tester distribution](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers).

Each run records its source commit in the job summary and retains archive/upload logs, symbols
and the distribution summary for 14 days. Check App Store Connect for the final build number.
This workflow ships the iOS/iPadOS binary; a native visionOS archive needs a separate release.

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

## Preserve features between releases

Compare the release source with the previous shipped build, including any changes made on
a separate release branch. A successful archive does not prove that those changes reached
main. Record the source commit with each uploaded build.

For conversation changes, include the applicable `PathwayConversationUITests` checks:
return-to-latest while working and idle, the changed-files bubble and diff sheet, model
selection with Save and Cancel, favourites, and compact composer/navigation controls.
Check the new-thread composer separately. Queue checks must cover both messages saved
in Cloud and messages already queued on the environment. Compilation and data-model
tests alone cannot confirm that a button is visible, tappable, or opens the correct sheet.

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
