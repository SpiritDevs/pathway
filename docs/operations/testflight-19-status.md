# TestFlight 1.0.13 build 19

Source: `3e42a644c` on `release/ios-testflight-19-20260913`, based on uploaded build 18.

Includes reconnect icon animation, native queue swipe actions and drag ordering, desktop/web cloud queue stack, and cloud reorder/steer operations. All pending changes from this work are committed and pushed. Unrelated original-workspace changes are preserved. Cloud operations require a separate backend deployment; desktop changes require a desktop update.

Validation: 48 focused web/backend tests passed; scoped web/backend type checks and lint passed; iOS simulator build passed. No UI/browser testing. All three shipping targets specify 1.0.13 (19); source encryption declaration remains boolean false. Production public configuration and saved account signing/export options are reused from build 18. No certificates changed.

Artifacts: `~/GitHub/pathway-ios-reconnect-spinner/.pathway/releases/1.0.13`. Native release commit bypassed the Git hook after focused checks.

Next: archive, verify actual archive and exported plists, signatures, entitlements and production configuration, then upload. Upload, processing and tester availability are unconfirmed.
