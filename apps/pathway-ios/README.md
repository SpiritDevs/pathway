# Pathway iOS

Pathway's native SwiftUI app lives in this directory. The Xcode project, targets, source symbols,
bundle identifiers, user-facing branding, and assets all use native Pathway identities.

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
The resulting Clerk session requests the existing `convex` JWT template and supplies that token to
`ConvexClientWithAuth`. Clerk persists and refreshes the session.

The production target uses:

- app name: `Pathway`
- bundle identifier: `com.spiritdevs.pathway`
- callback: `pathway://callback`
- associated domain: `clerk.spiritdevs.com`

The Clerk Dashboard must have Native API enabled and register the production bundle identifier and
Apple App ID prefix before hosted authentication can complete on a signed build.

## Current product boundary

The SwiftUI foundation now contains only Pathway-native placeholders for Agents, Issues, Threads,
Environments, and Settings. QuoteCloud document creation, document services, sending, sharing,
approvals, billing, and workspace-specific backend contracts are intentionally excluded.

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
```
