# TestFlight 1.0.13 build 14 recovery

Recovery started on 2026-09-12 on the Mac Studio that uploaded build 13.
Source is `e030add279629cc6eb049ee6d5753a886eb97aa3` from
`release/ios-testflight-connection-fixes-20260912`. This status branch changes only this report.

## Initial signing findings

Read the successful build 13 thread through its final activity and messages. Build 13 was
version 1.0.12, built from an isolated checkout. It used a signed Release archive, then
`xcodebuild -exportArchive -allowProvisioningUpdates` with Xcode's saved Apple account.
Export options specified automatic signing, app-store-connect, upload destination,
symbol upload, and disabled automatic version/build changes. No API-key arguments were used.
The same export options and build 13 archive/logs remain on this Mac.

Apple reported upload success at 2026-09-12 03:42:46 UTC. That thread confirmed processing
had started, but did not confirm tester availability. Its eight focused login and clipboard
tests passed, and it verified the app and both extensions' versions, signatures, and production
Clerk configuration.

Current keychain inspection found three valid Apple Development identities and no local
Apple Distribution identity. Build 13's successful account-based automatic signing route
is therefore the first recovery path to test. Its current authentication has not yet been verified.

## Current state and next step

No build 14 archive, export, or upload has been started by this recovery task. A fresh App Store
Connect query is next, to avoid duplicate delivery. If absent, build the exact release source
in a separate checkout using the existing production public configuration, then reuse build 13's
account and export settings. Verify distribution signing before upload and check Apple's
processing and tester state afterward. If account signing is unavailable, test the existing API
credentials for standard certificate/profile provisioning without revoking existing certificates.

No human action is currently requested. TestFlight upload is authorized; public App Store
release is outside this task. Credentials and account identifiers are omitted from this report.

## Signing access confirmed

At 2026-09-12 10:10 UTC, local export of the retained build 13 archive succeeded using
the saved Xcode account and automatic distribution signing. A distribution IPA was produced
locally; it was not uploaded. Apple authenticated the account and returned the Pathway app.
Its validation response reported 13 as the previously uploaded bundle version. This was
an export-time validation response, not a full TestFlight build-list query. No local API key
has been found in the usual credential locations.

The exact build 14 source is now in a separate clean checkout. Production public configuration
was generated from the existing production environment, and archive compilation is underway.
The working Xcode account removes the need to create a distribution certificate or profiles
manually. Build 14 upload and tester verification remain pending.

## Build 14 signed and verified

The exact source commit archived successfully, then App Store distribution export succeeded
on 2026-09-12 at 10:15 UTC using the same saved Xcode account as build 13. The main app,
share extension, and widget all contain version 1.0.13 build 14. Strict signature verification
passed for all three. Their signed identifiers, team, and App Groups match their App Store
profiles. Debug entitlements are disabled and the app uses production APNs.

All five public runtime settings match the build 13 archive. The production Clerk association
was checked live. The terminal bundle manifest and Xcode project plist passed verification.
No source files changed. Earlier release testing is recorded in the original status report;
this recovery ran archive, package, signing, and configuration checks without repeating UI tests.

Exported IPA SHA-256: `ae9fd16315ed1b1efcbc2f96413bbfdf7c6350abbcfc651776ec1e011618a18a`.
The archive and package are retained in the isolated release checkout under
`.pathway/releases/1.0.13`. Upload is the next step; tester availability remains unconfirmed.
