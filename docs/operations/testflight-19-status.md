# TestFlight 1.0.13 build 19

**Upload complete at 2026-09-13 02:14:08 UTC. Apple reports PROCESSING; tester availability is unconfirmed.**

Source: `3e42a644c` on `release/ios-testflight-19-20260913`, based on uploaded build 18.

Includes reconnect icon animation, native queue swipe actions and drag ordering, desktop/web cloud queue stack, and cloud reorder/steer operations. All pending changes from this work are committed and pushed. Unrelated original-workspace changes are preserved. Cloud operations require a separate backend deployment; desktop changes require a desktop update.

Validation: 48 focused web/backend tests passed; scoped web/backend type checks and lint passed; iOS simulator build passed. No UI/browser testing. All three shipping targets specify 1.0.13 (19); source encryption declaration remains boolean false. Production public configuration and saved account signing/export options are reused from build 18. No certificates changed.

Artifacts: `~/GitHub/pathway-ios-reconnect-spinner/.pathway/releases/1.0.13`. Native release commit bypassed the Git hook after focused checks.

Next: archive, verify actual archive and exported plists, signatures, entitlements and production configuration, then upload. Upload, processing and tester availability are unconfirmed.

## Signed package validation

Archive and App Store export succeeded. Actual archived and exported app Info.plist values contain ITSAppUsesNonExemptEncryption as boolean false. App and both extensions are 1.0.13 (19). Strict signatures pass, entitlements match build 18 and embedded profiles, exported debug access is disabled, and APNs/public runtime configuration remains production.

IPA SHA-256: `ad4a05542fc5f18e63ba89242f47b96a560a649a8b60df594fb2ed32dcde23a3`.

Next: upload the verified archive using saved Xcode account. Processing and tester availability remain unconfirmed.

## Apple upload receipt

Xcode exited with code 0 and reported `Upload succeeded`, `Uploaded package is processing`, and `EXPORT SUCCEEDED`. No duplicate-build rejection occurred.

```json
{
  "buildResourceId": "f94a3338-9553-48f0-9d48-604f3f554059",
  "version": "19",
  "uploadedDate": "2026-09-12T19:14:08-07:00",
  "processingState": "PROCESSING"
}
```

Uploaded source: `3e42a644c` on `release/ios-testflight-19-20260913`. Upload used the verified archive and saved Xcode account. Raw diagnostics remain local in `upload-19.xcdistributionlogs`; the sanitized receipt is retained as `apple-upload-receipt.json`. No public App Store release was submitted.

Upload is complete. Processing completion and tester availability are unconfirmed. The new cloud queue operations and desktop UI are committed and pushed but still require backend deployment and a desktop update.
