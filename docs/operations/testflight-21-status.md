# TestFlight 1.0.13 build 21

Apple accepted the upload on 2026-09-13 at 04:35:26 UTC and reported `PROCESSING`. Tester availability has not been confirmed.

Uploaded source: `b59fa53e46cfcbb9c75987f2d7ceab9bc4ca5306` on `release/ios-testflight-21-20260913`, based on build 20. The restoration is committed separately on the release branch and `work/ios-conversation-updates-20260913`; both are pushed.

The compact conversation row again places navigation on the left, the composer in the middle, and the orchestrator on the right. Expanding the composer uses the full editing width. Tapping the conversation returns to the compact row and preserves the draft. Expanding navigation hides the middle composer until navigation collapses. Wider layouts retain their sidebar and editor.

The conversation rewrite had hidden the shell in thread details and removed the composer's reserved side spacing. This release restores that shared layout and reconnects the navigation expansion state.

Validation: iOS simulator compilation, signed Release archive, and App Store export passed. The app, widget, and share extension all report `1.0.13 (21)`. Signatures and provisioning entitlements match, exported debug access is disabled, production configuration is unchanged, and the encryption declaration is boolean false. Xcode reported `Upload succeeded`, `Uploaded package is processing`, and `EXPORT SUCCEEDED`, then exited successfully.

Interactive Simulator verification was requested but not authorized during this run, so the visual layout and gestures remain unverified in a running client.

Artifacts are retained in `~/GitHub/pathway-testflight-20-release/.pathway/releases/1.0.13`, using build-21 filenames. IPA SHA-256: `b1e14871808390217370ffe0abef48a2c67620c491c5d524d0bc755462966825`.
