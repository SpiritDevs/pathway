# TestFlight 1.0.13 build 21

Apple accepted the upload on 2026-09-13 at 04:35:26 UTC and reported `PROCESSING`. Tester availability has not been confirmed.

Uploaded source: `b59fa53e46cfcbb9c75987f2d7ceab9bc4ca5306` on `release/ios-testflight-21-20260913`, based on build 20. The restoration is committed separately on the release branch and `work/ios-conversation-updates-20260913`; both are pushed.

The compact conversation row again places navigation on the left, the composer in the middle, and the orchestrator on the right. Expanding the composer uses the full editing width. Tapping the conversation returns to the compact row and preserves the draft. Expanding navigation hides the middle composer until navigation collapses. Wider layouts retain their sidebar and editor.

The conversation rewrite had hidden the shell in thread details and removed the composer's reserved side spacing. This release restores that shared layout and reconnects the navigation expansion state.

Validation: iOS simulator compilation, signed Release archive, and App Store export passed. The app, widget, and share extension all report `1.0.13 (21)`. Signatures and provisioning entitlements match, exported debug access is disabled, production configuration is unchanged, and the encryption declaration is boolean false. Xcode reported `Upload succeeded`, `Uploaded package is processing`, and `EXPORT SUCCEEDED`, then exited successfully.

After permission was granted, interactive verification and `PathwayConversationUITests/testCompactComposerAndNavigationDismissOutside` passed on iPhone 17 with iOS 26.3. The Debug conversation fixture now uses the production compact shell, with isolated conversation data. The test verifies the left-navigation/center-composer/right-orchestrator arrangement, keyboard dismissal from a conversation tap, both navigation menus collapsing on outside taps, and draft preservation after reopening the composer and orchestrator sheet. This checks native layout and interaction; the fixture does not verify cloud-backed orchestrator requests. No additional product behavior changes were needed after build 21.

Six XCTest screenshots and their manifest are retained in `.pathway/verification/compact-conversation-21` in the release worktree. The passing result bundle is `~/Library/Developer/XcodeBuildMCP/workspaces/pathway-6d695be6fd16/result-bundles/test_sim_2026-09-13T04-44-06-385Z_pid66698_4a84583c.xcresult`. This change applies to native compact navigation and conversation entry points; provider contracts, web, desktop, and connection modes are unchanged. Regular-width iPad and visionOS were not interactively tested in this pass.

Artifacts are retained in `~/GitHub/pathway-testflight-20-release/.pathway/releases/1.0.13`, using build-21 filenames. IPA SHA-256: `b1e14871808390217370ffe0abef48a2c67620c491c5d524d0bc755462966825`.
