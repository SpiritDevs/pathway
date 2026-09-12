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
