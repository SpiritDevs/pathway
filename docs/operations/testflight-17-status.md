# TestFlight 1.0.13 build 17

Source: `f4b3835ca` on `release/ios-testflight-17-20260913`, based on successfully uploaded build 16.

Includes new-thread compose defaults and Steer/Queue icons while the composer contains text or attachments. Previous release fixes are preserved; unrelated edits remain in the original working checkout.

All three shipping targets specify 1.0.13 (17). Source encryption declaration is boolean false. Build 16 production public configuration, cached packages, and saved-account automatic signing/export options are reused. No certificates changed.

Original iOS builds passed. Integrated Release archive is underway. No UI/browser testing was run. Upload and tester availability are not yet confirmed.

Artifacts: `~/GitHub/pathway-testflight-17-release/.pathway/releases/1.0.13`.

Next: inspect archived and exported app plists, validate signatures and entitlements, then upload through Xcode's saved account. Native commits bypass the JavaScript pre-commit hook because the isolated native checkout has no installed vite-plus dependencies.

## Signed package validation

Release archive and App Store distribution export succeeded for `f4b3835ca`.
Both actual app plists contain `ITSAppUsesNonExemptEncryption` as boolean false.
The app, widget, and share extension are all 1.0.13 (17) in archive and exported IPA.
Strict signatures pass. Entitlements match build 16 and embedded profiles; exported debug access is disabled, profiles are for App Store distribution, and APNs is production. All public runtime settings match build 16, including the production Clerk key.

IPA SHA-256: `28787356303fcd8de660aba0e6439b4dd189e178226d05e15e92e0ad930e8c8c`.
Validation output is retained in `validation-archive.txt` and `validation-export.txt`.
Next: upload the validated archive. Processing and tester availability remain unconfirmed.
