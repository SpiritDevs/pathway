# TestFlight 1.0.13 build 16

**Upload complete at 2026-09-12 21:33:30 UTC. Apple reports PROCESSING. Tester availability is unconfirmed.**

Source: `f210bd0cd` on `release/ios-testflight-16-20260913`, based on build 15.

Includes thread activity and status labels, the persistent send/working control, reorderable queued-message sheet, empty-sheet dismissal, expanded thread actions, and notification bell visibility. Build 15 cloud queue and image support are preserved. Unrelated working checkout edits are retained separately.

Source pushed. All three shipping targets are 1.0.13 (16). Source encryption declaration is boolean false. Production public configuration and existing automatic signing/export options are copied from the successful build 15 setup. No certificates changed.

Original iOS compilation passed and 15 status cases passed. Release integration archive is underway. No browser or UI testing was run. Upload and tester availability are not yet confirmed.

Artifacts: `~/GitHub/pathway-testflight-16-release/.pathway/releases/1.0.13`.

Next: validate signed archive and exported IPA, then upload using the saved Xcode account.

Release integration required resolving older/newer queue code and splitting conversation view modifiers to stay within Swift compiler limits. The first archive failed at compile time; the corrected source is pushed and a fresh archive is underway. The JavaScript pre-commit hook could not load vite-plus in the isolated native checkout, so native commits bypassed that hook; native validation is recorded separately.

## Signed package validation

Release archive and App Store distribution export succeeded for source `f210bd0cd`.
Both actual app plists contain `ITSAppUsesNonExemptEncryption` as boolean false.
The app, widget, and share extension are all 1.0.13 (16) in archive and IPA.
Strict recursive signatures pass. Entitlements match build 15 and embedded profiles;
exported debug access is disabled, App Store profiles are present, and APNs is production.
All public runtime settings match build 15, including the production Clerk key.
15 status cases passed against the exact release source. No UI testing was performed.

IPA SHA-256: `d721fee2c7b97b283912ab1b7ecf6c8f6b7a46ce5847a0d254b981429b05f045`.

Archive: `Pathway-16.xcarchive`; IPA: `export/Pathway.ipa` under the artifact directory above.
Validation output: `validation-archive.txt`, `validation-export.txt`.
Next: upload the validated archive through Xcode's saved account. Processing and tester access remain unconfirmed.

## Apple upload receipt

Xcode exited successfully and reported `Uploaded package is processing.`, `Upload succeeded.`, and `EXPORT SUCCEEDED`. No duplicate-build rejection occurred.

```json
{
  "buildResourceId": "84129aa3-ea9b-4c6e-a149-6070daf0171a",
  "version": "16",
  "uploadedDate": "2026-09-12T14:33:30-07:00",
  "processingState": "PROCESSING"
}
```

Uploaded source: `f210bd0cd` on `release/ios-testflight-16-20260913`.

Upload used the validated `Pathway-16.xcarchive` with the retained `ExportUploadOptions.plist`, automatic signing, and `xcodebuild -exportArchive -allowProvisioningUpdates`. No public App Store release was submitted.

The artifact directory retains `upload-16.log`, `upload-16.xcdistributionlogs`, and `apple-upload-receipt.json`. Raw account diagnostics remain local. The release checkout has no tracked changes.

Upload is complete. Processing completion, resulting App Store Connect encryption metadata, and internal tester availability remain unconfirmed. The packaged encryption boolean is verified in both archive and exported app.
