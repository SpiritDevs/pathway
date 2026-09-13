# TestFlight 1.0.13 build 20

Apple accepted the upload on 2026-09-13 at 03:56:27 UTC and reported `PROCESSING`. Tester availability has not been confirmed.

Uploaded source: `a6facb3f338c49a77b55e5e86807dc2013169d05` on `release/ios-testflight-20-20260913`. The release integrates ten separate pending-work commits from `work/ios-conversation-updates-20260913` with build 19. Both branches are pushed.

The conversation dismisses composer focus when tapped outside the field. Expanded compact navigation collapses when the main content is tapped. The release includes the pending Settings consolidation and preserves build 19's cloud queue, swipe actions, image decoding, and visualization support.

Validation:

- 66 focused server, web, and shared-client tests passed before integration.
- The integrated iOS simulator build passed.
- 11 image-upload and activity tests passed against copied release sources in an isolated macOS Swift package.
- The native terminal bundle matches its tracked sources and assets.
- Signed Release archive and App Store export passed. The archived and exported app, widget, and share extension all report `1.0.13 (20)`.
- Signatures and provisioning entitlements match; exported debug access is disabled. Production configuration matches build 19, and the encryption declaration is boolean false.
- Xcode reported `Upload succeeded`, `Uploaded package is processing`, and `EXPORT SUCCEEDED`, then exited successfully.

No browser or interactive simulator verification was performed. The Swift-only commit and release integration commits bypassed the formatter hook, which excludes Swift files; build and scoped checks ran separately.

Artifacts are retained in `~/GitHub/pathway-testflight-20-release/.pathway/releases/1.0.13`, including the archive, exported IPA, logs, and sanitized Apple receipt. IPA SHA-256: `5b34837558b073e7e4235418bba103368edd96e22b9da4bbabb78514d21bc014`.
