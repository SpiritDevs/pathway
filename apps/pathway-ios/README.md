# Pathway iOS

Pathway's native SwiftUI app lives in this directory. One target owns the shared product screens
and adapts its shell for compact iPhone windows, regular-width iPad windows, and native visionOS
windows. The Xcode project, source symbols, bundle identifiers, user-facing branding, and assets
all use native Pathway identities.

## Requirements

- Xcode 26.2 or newer with the iOS and visionOS platform components
- SwiftFormat and SwiftLint for local checks
- Pathway's public Clerk, Convex, and relay configuration

## Public configuration

The native app uses the same repository-root public identifiers as Pathway web and desktop:

- `PATHWAY_CLERK_PUBLISHABLE_KEY`
- `PATHWAY_CONVEX_URL`
- `PATHWAY_RELAY_URL` (defaults to `https://relay.spiritdevs.com`)

Set the values in the repository-root `.env` or `.env.local`, then generate the ignored Xcode
configuration file:

```sh
node scripts/configure-pathway-ios.ts
```

No Clerk secret key or other server-side credential belongs in the Xcode project. When required
public configuration is absent, the app renders a configuration message instead of connecting to
an unrelated or stale deployment.

## Authentication

The app uses Clerk's official native Swift SDK. Hosted authentication follows the sign-in methods,
verification rules, MFA, and recovery flows configured for the existing Pathway Clerk instance.
Clerk persists and refreshes the session. The app shell intentionally depends only on this
platform-neutral authentication boundary. Backend features should consume Clerk tokens through a
cross-platform client or adapter rather than importing a platform-limited SDK into shared views.

The production target uses:

- app name: `Pathway`
- bundle identifier: `com.spiritdevs.pathway`
- callback: `pathway://callback`
- associated domain: `clerk.spiritdevs.com`

The Clerk Dashboard must have Native API enabled and register the production bundle identifier and
Apple App ID prefix before hosted authentication can complete on a signed build.

## Current product boundary

The release targets iOS, iPadOS, and visionOS. Android is outside this version.

Shared native screens include threads and approvals, Issues, Calendar, captured Email, Projects,
Contacts, Time Tracker, thread-scoped source control and pull requests, files, and remote terminals.
Administration covers companies, teams, roles, connections, providers, scheduled tasks, and usage.
Contacts and timers use shared cloud persistence with an explicit desktop import for old local data.
Backend and relay updates must be deployed together with these clients.

The compact shell uses the floating navigation bar on iPhone and narrow iPad windows. Regular iPad
windows use a system `NavigationSplitView`. visionOS uses the same sidebar/detail model in a native
resizable window and opens agent creation and Settings as independent windows. The agent button
opens the real new-thread flow.

The app includes account-scoped shared drafts and App Intents. The iOS-only share extension accepts
text, URLs and files for review before sending; camera and document capture also remain iOS-only.
The widget extension includes saved work summaries on iOS/iPadOS and visionOS; its ActivityKit surface is iOS-only. visionOS uses ordinary notifications and the native
Convex WebSocket/HTTP transport. See `docs/operations/apple-client-release.md` for signing and
external-service requirements, and `docs/plans/mobile-parity-completion.md` for current verification.

## Checks

From `apps/pathway-ios`:

```sh
swiftformat Pathway PathwayTests PathwayUITests --lint
swiftlint lint --strict
xcodebuild \
  -project Pathway.xcodeproj \
  -scheme Pathway \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  build

xcodebuild \
  -project Pathway.xcodeproj \
  -scheme Pathway \
  -destination 'platform=iOS Simulator,name=iPad Pro 13-inch (M5)' \
  build

xcodebuild \
  -project Pathway.xcodeproj \
  -scheme Pathway \
  -destination 'platform=visionOS Simulator,name=Apple Vision Pro' \
  build
```

Run all three builds whenever shared navigation, authentication, assets, or app wiring changes.
