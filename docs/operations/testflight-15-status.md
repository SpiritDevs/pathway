# TestFlight 1.0.13 build 15 status

Started on 2026-09-12. Upload is authorized. Archive and upload have not started.

Source is `b19ec09257e876445bf2b880994edd219b2acac8` from
`release/ios-testflight-15-20260912`. This report branch is based on that source and changes
only this document. The isolated release checkout is `~/GitHub/pathway-testflight-15-release`.
Build 14 artifacts and unrelated working changes are preserved.

The app and both extension targets specify version 1.0.13 build 15 in Debug and Release.
The source app Info.plist contains `ITSAppUsesNonExemptEncryption` as boolean false.
The diff from build 14 contains only that declaration, target build numbers, and release docs.
Packaged declaration, signatures, and production configuration have not yet been verified.

Build 14's recovery report and retained logs confirm successful saved-account automatic signing
and upload. The thread tool could not load its completed conversation; local record lookup is
in progress. Existing build 14 public production configuration and cached packages will be reused.
No certificate recreation or Apple build 14 metadata mutation is planned.

Next, archive the exact source, export locally with the saved Xcode account, and verify the
actual archived and exported app plist boolean, all target versions, signatures, entitlements,
and production configuration before upload. Publish signing evidence, then use the known working
upload route. A duplicate-build validation response will stop upload work for investigation.

Upload completion, Apple processing, and tester availability will be reported separately.
Root is checking Apple build state with existing read-only CI credentials. No additional local
query credentials or manual Apple checks are needed. No UI tests, PR, main merge, or public
App Store release are part of this delivery.
