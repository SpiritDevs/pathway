# TestFlight 1.0.13 build 18

Source: `659a2e946` on `release/ios-testflight-18-20260913`, based on uploaded build 17.

Includes HEIC/HEIF conversion to JPEG or transparent PNG, project-picker icons, stable composer focus binding, centered cloud/environment queue counter and sheet, and a full navigation browser with reconnect and corrected scroll scaling. The server hosted-browser service retention fix is pushed with this branch but requires a separate environment deployment; TestFlight does not update the server.

All shipping targets specify 1.0.13 (18). Source encryption declaration is boolean false. Production public configuration, cached packages, and automatic signing/export options are reused from build 17. No certificates changed. Unrelated original-workspace edits are retained.

Six image-conversion tests passed, including orientation, transparency, byte-format detection, invalid input, and unchanged compatible files. Nine focused server browser tests passed. iOS source builds and focused test compilation passed before integration; release archive is underway. No UI/browser testing was performed.

Artifacts: `~/GitHub/pathway-testflight-18-release/.pathway/releases/1.0.13`.

Next: verify actual packaged plists, signatures, entitlements, and production configuration; export and upload through the saved Xcode account. Upload and tester availability are unconfirmed. Native checkout commits bypassed the JavaScript hook because vite-plus dependencies are not installed there.

## Signed package validation

Release archive and App Store distribution export succeeded for `659a2e946`.
Both actual app plists contain `ITSAppUsesNonExemptEncryption` as boolean false.
All three bundles are 1.0.13 (18) in archive and IPA. Strict signatures pass.
Entitlements match build 17 and embedded profiles. Exported debug access is disabled,
profiles are for App Store distribution, and APNs is production. Public runtime settings match build 17.
Conversion source and its six tested cases are byte-identical to the validated files.

IPA SHA-256: `0fcccc798cd472214c515df527051f9870c82f433050c3f0e8ad8d84838504da`.
Validation outputs: `validation-archive.txt` and `validation-export.txt` in the artifact directory.
Next: upload the validated archive. Processing and tester availability are unconfirmed.
