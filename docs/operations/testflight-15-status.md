# TestFlight 1.0.13 build 15 status

**Upload complete on 2026-09-12 at 10:31:36 UTC.** Apple accepted Pathway 1.0.13 build 15
and reported processing. Processing completion and tester availability remain unconfirmed.
The actual archived and exported app both contain the encryption declaration as boolean false.

## Initial findings

Started on 2026-09-12 with upload authorization. The following records the initial checkpoint.

Source is `b19ec09257e876445bf2b880994edd219b2acac8` from
`release/ios-testflight-15-20260912`. This report branch is based on that source and changes
only this document. The isolated release checkout is `~/GitHub/pathway-testflight-15-release`.
Build 14 artifacts and unrelated working changes are preserved.

The app and both extension targets specify version 1.0.13 build 15 in Debug and Release.
The source app Info.plist contains `ITSAppUsesNonExemptEncryption` as boolean false.
The diff from build 14 contains only that declaration, target build numbers, and release docs.
Packaged declaration, signatures, and production configuration have not yet been verified.

Build 14's recovery report and retained logs confirm successful saved-account automatic signing
and upload. The completed build 14 conversation was read using its full local thread ID.
Its final receipt and retained commands agree with the recovery report. Existing build 14 public production configuration and cached packages will be reused.
No certificate recreation or Apple build 14 metadata mutation is planned.

Next, archive the exact source, export locally with the saved Xcode account, and verify the
actual archived and exported app plist boolean, all target versions, signatures, entitlements,
and production configuration before upload. Publish signing evidence, then use the known working
upload route. A duplicate-build validation response will stop upload work for investigation.

Upload completion, Apple processing, and tester availability will be reported separately.
Root is checking Apple build state with existing read-only CI credentials. No additional local
query credentials or manual Apple checks are needed. No UI tests, PR, main merge, or public
App Store release are part of this delivery.

## Archive and distribution validation

At 2026-09-12 10:29 UTC, Release archive and local App Store distribution export succeeded
with Xcode's saved account and automatic signing. No certificate was recreated.

Both actual packaged app plists were decoded and checked with Python `plistlib` using
`value is False`. The archive app and the app extracted from the exported IPA both contain
`ITSAppUsesNonExemptEncryption` as boolean false, not a string or missing value.
The app, widget, and share extension each contain version 1.0.13 build 15 in both packages.

Strict recursive signature verification passed for all three bundles in both packages.
Signed entitlements exactly match the corresponding build 14 archive/export entitlements.
Identifiers, team, App Groups, and APNs/debug entitlements match the embedded profiles.
The development-signed archive retains build 14's development signing behavior; export
re-signs for App Store distribution. The exported app and extensions have debug access
disabled and App Store profiles, and the exported app has production APNs.

All five public runtime settings and the APNs plist setting exactly match build 14.
The packaged Clerk key is production. The terminal bundle manifest and project/app plist
checks passed. `Package.resolved` and all tracked release source remain unchanged.
No UI, simulator, browser, or computer-use testing was run for these metadata changes.

Exported IPA SHA-256 is
`9b3ff5ceae0b62b548d019c94dfba51156ef4a80d5c567c8c5bcefcf270fd1d6`.
Artifacts and validation output are retained under the release checkout's
`.pathway/releases/1.0.13`, including `Pathway-15.xcarchive`, `export/Pathway.ipa`,
`validation-archive.txt`, and `validation-export.txt`.

At this signing checkpoint, upload was the next step. Its completed receipt follows below.

## Reproduction commands

Run from `~/GitHub/pathway-testflight-15-release`. `Config/Local.xcconfig` is copied from
build 14's release checkout. Cached `SourcePackages` are copied into the artifact directory.
Local export options are copied from build 14's successful local export. Upload options
are the same retained options used by builds 13 and 14, with automatic signing,
`app-store-connect`, symbol upload, and automatic version/build changes disabled.
Account and team identifiers remain only in the ignored local options files.

```sh
xcodebuild -project apps/pathway-ios/Pathway.xcodeproj -scheme Pathway \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath .pathway/releases/1.0.13/Pathway-15.xcarchive \
  -derivedDataPath .pathway/releases/1.0.13/DerivedData \
  -clonedSourcePackagesDirPath .pathway/releases/1.0.13/SourcePackages \
  -disableAutomaticPackageResolution -allowProvisioningUpdates archive

xcodebuild -exportArchive \
  -archivePath .pathway/releases/1.0.13/Pathway-15.xcarchive \
  -exportPath .pathway/releases/1.0.13/export \
  -exportOptionsPlist .pathway/releases/1.0.13/ExportLocalOptions.plist \
  -allowProvisioningUpdates
```

## Apple upload receipt

Apple accepted build 15 at 2026-09-12 10:31:36 UTC. The upload command exited with code 0.
Xcode reported `Uploaded package is processing.`, `Upload succeeded.`, `Uploaded Pathway`,
and `EXPORT SUCCEEDED`. Apple did not reject a duplicate build number.

The build resource ID is `9e5ee750-b653-4082-8e46-f4ecd53d9706`.
The sanitized Apple response was:

```json
{
  "buildResourceId": "9e5ee750-b653-4082-8e46-f4ecd53d9706",
  "version": "15",
  "uploadedDate": "2026-09-12T03:31:36-07:00",
  "processingState": "PROCESSING",
  "processingErrors": [],
  "buildProcessingState": {
    "errors": [],
    "warnings": [],
    "infos": [],
    "state": "PROCESSING"
  }
}
```

Upload used the validated archive and the existing saved Xcode account:

```sh
xcodebuild -exportArchive \
  -archivePath .pathway/releases/1.0.13/Pathway-15.xcarchive \
  -exportPath .pathway/releases/1.0.13/upload \
  -exportOptionsPlist .pathway/releases/1.0.13/ExportUploadOptions.plist \
  -allowProvisioningUpdates
```

The upload log is retained at
`~/GitHub/pathway-testflight-15-release/.pathway/releases/1.0.13/upload-15.log`.
The same directory retains the archive, dSYMs, exported IPA, validation output, sanitized
`apple-upload-receipt.json`, and copied `upload-15.xcdistributionlogs` diagnostics.
Raw distribution diagnostics remain local because they contain account metadata.

## Processing handoff

Upload is complete. Apple's last confirmed response reports processing, with no processing
errors, warnings, or informational issues. Completed processing and tester availability have
not been established here. The packaged encryption boolean is verified; the resulting
App Store Connect `usesNonExemptEncryption` field still needs Root's read-only confirmation.

Root can query the build resource above using the existing CI credentials to confirm
`processingState=VALID`, `usesNonExemptEncryption=false`, and
`buildBetaDetail.internalBuildState=IN_BETA_TESTING`, plus access through the existing Main
internal group. No new query credentials or manual Apple check are requested on this Mac.
Build 14's record was not changed. No public App Store release was submitted.

The release checkout remains at the exact source commit with no tracked modifications.
Build 14 artifacts and unrelated work are preserved. Only this report was committed and
pushed on `status/testflight-15-20260912`. No PR was opened or main merge performed.
