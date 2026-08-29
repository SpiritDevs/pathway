# Pathway iOS

Pathway's native SwiftUI app lives in this directory. One target owns the shared product screens
and adapts its shell for compact iPhone windows, regular-width iPad windows, and native visionOS
windows. The Xcode project, source symbols, bundle identifiers, user-facing branding, and assets
all use native Pathway identities.

## Requirements

- Xcode 27 or newer
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

The SwiftUI foundation now contains only Pathway-native placeholders for Dashboard, Issues, Agent
Threads, Email, Source Control, Calendar, Projects, Contacts, Time Tracker, and Settings. Copied
product-domain screens and backend contracts are intentionally excluded.

The compact shell uses the floating navigation bar on iPhone and narrow iPad windows. Regular iPad
windows use a system `NavigationSplitView`, including automatic collapse in narrow multitasking
layouts. visionOS uses that shared sidebar/detail model in a native resizable window and opens the
agent orchestrator and Settings as independent windows.

The detached chat button in the main bar presents the native Agent Orchestrator sheet. The
placeholder includes chat history and close controls, prompt suggestions, mentions, attachments,
and a keyboard-focused composer while agent and workflow contracts are ported.

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
