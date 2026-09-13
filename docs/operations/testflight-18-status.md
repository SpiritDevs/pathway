# TestFlight 1.0.13 build 18

Source: `659a2e946` on `release/ios-testflight-18-20260913`, based on uploaded build 17.

Includes HEIC/HEIF conversion to JPEG or transparent PNG, project-picker icons, stable composer focus binding, centered cloud/environment queue counter and sheet, and a full navigation browser with reconnect and corrected scroll scaling. The server hosted-browser service retention fix is pushed with this branch but requires a separate environment deployment; TestFlight does not update the server.

All shipping targets specify 1.0.13 (18). Source encryption declaration is boolean false. Production public configuration, cached packages, and automatic signing/export options are reused from build 17. No certificates changed. Unrelated original-workspace edits are retained.

Six image-conversion tests passed, including orientation, transparency, byte-format detection, invalid input, and unchanged compatible files. Nine focused server browser tests passed. iOS source builds and focused test compilation passed before integration; release archive is underway. No UI/browser testing was performed.

Artifacts: `~/GitHub/pathway-testflight-18-release/.pathway/releases/1.0.13`.

Next: verify actual packaged plists, signatures, entitlements, and production configuration; export and upload through the saved Xcode account. Upload and tester availability are unconfirmed. Native checkout commits bypassed the JavaScript hook because vite-plus dependencies are not installed there.
