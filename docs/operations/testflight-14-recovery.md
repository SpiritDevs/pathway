# TestFlight 1.0.13 build 14 recovery

**Uploaded successfully on 2026-09-12 at 10:18:57 UTC.** Apple accepted the package and
reported that processing had started. Processing completion and tester availability are
not yet confirmed. The following sections record the recovery evidence in order.

Recovery started on 2026-09-12 on the Mac Studio that uploaded build 13.
Source is `e030add279629cc6eb049ee6d5753a886eb97aa3` from
`release/ios-testflight-connection-fixes-20260912`. This status branch changes only this report.

## Initial signing findings

Read the successful build 13 thread through its final activity and messages. Build 13 was
version 1.0.12, built from an isolated checkout. It used a signed Release archive, then
`xcodebuild -exportArchive -allowProvisioningUpdates` with Xcode's saved Apple account.
Export options specified automatic signing, app-store-connect, upload destination,
symbol upload, and disabled automatic version/build changes. No API-key arguments were used.
The same export options and build 13 archive/logs remain on this Mac.

Apple reported upload success at 2026-09-12 03:42:46 UTC. That thread confirmed processing
had started, but did not confirm tester availability. Its eight focused login and clipboard
tests passed, and it verified the app and both extensions' versions, signatures, and production
Clerk configuration.

Current keychain inspection found three valid Apple Development identities and no local
Apple Distribution identity. Build 13's successful account-based automatic signing route
is therefore the first recovery path to test. Its current authentication has not yet been verified.

## Current state and next step

No build 14 archive, export, or upload has been started by this recovery task. A fresh App Store
Connect query is next, to avoid duplicate delivery. If absent, build the exact release source
in a separate checkout using the existing production public configuration, then reuse build 13's
account and export settings. Verify distribution signing before upload and check Apple's
processing and tester state afterward. If account signing is unavailable, test the existing API
credentials for standard certificate/profile provisioning without revoking existing certificates.

No human action is currently requested. TestFlight upload is authorized; public App Store
release is outside this task. Credentials and account identifiers are omitted from this report.

## Signing access confirmed

At 2026-09-12 10:10 UTC, local export of the retained build 13 archive succeeded using
the saved Xcode account and automatic distribution signing. A distribution IPA was produced
locally; it was not uploaded. Apple authenticated the account and returned the Pathway app.
Its validation response reported 13 as the previously uploaded bundle version. This was
an export-time validation response, not a full TestFlight build-list query. No local API key
has been found in the usual credential locations.

The exact build 14 source is now in a separate clean checkout. Production public configuration
was generated from the existing production environment, and archive compilation is underway.
The working Xcode account removes the need to create a distribution certificate or profiles
manually. Build 14 upload and tester verification remain pending.

## Build 14 signed and verified

The exact source commit archived successfully, then App Store distribution export succeeded
on 2026-09-12 at 10:15 UTC using the same saved Xcode account as build 13. The main app,
share extension, and widget all contain version 1.0.13 build 14. Strict signature verification
passed for all three. Their signed identifiers, team, and App Groups match their App Store
profiles. Debug entitlements are disabled and the app uses production APNs.

All five public runtime settings match the build 13 archive. The production Clerk association
was checked live. The terminal bundle manifest and Xcode project plist passed verification.
No source files changed. Earlier release testing is recorded in the original status report;
this recovery ran archive, package, signing, and configuration checks without repeating UI tests.

Exported IPA SHA-256: `ae9fd16315ed1b1efcbc2f96413bbfdf7c6350abbcfc651776ec1e011618a18a`.
The archive and package are retained in the isolated release checkout under
`.pathway/releases/1.0.13`. Upload is the next step; tester availability remains unconfirmed.

## Apple upload receipt

Apple accepted Pathway 1.0.13 build 14 at 2026-09-12 10:18:57 UTC. The upload command
finished with exit code 0. Its final messages were `Uploaded package is processing.`,
`Upload succeeded.`, `Uploaded Pathway`, and `EXPORT SUCCEEDED`.

The receipt log is retained at
`~/GitHub/pathway-testflight-14-release/.pathway/releases/1.0.13/upload-14.log`.
The signed archive, dSYMs, exported IPA, and distribution diagnostics are retained locally.
Apple's build-14 export-time validation returned HTTP 201 before upload, confirming that
this build number was accepted. No new build number or replacement certificate was needed.

Processing has started. Upload success does not establish TestFlight tester availability.
Final processing and tester-access verification is limited as described below. No public App Store release
was submitted, and no production service configuration or unrelated working tree was changed.

## Final verification and handoff

At 2026-09-12 10:20 UTC, a separate `altool --build-status` check could not authenticate.
The tool requires an App Store Connect API key or username, app-specific password, and
provider selection. The saved Xcode account successfully signs and uploads, but is not
available to that standalone command. No usable separate API key or app-specific password
was found in the local credential locations inspected. A direct saved-account query attempt
also could not obtain a usable session. No credentials were changed or authentication bypassed.

Apple's last confirmed server response is from 10:18:57 UTC. The uploaded build resource is
`51d6e0da-3e82-4f85-8f79-f05c86e4fd42`. Both `processingState` and
`buildProcessingState.state` were `PROCESSING`; the response contained no errors, warnings,
or informational issues. This confirms an accepted upload, not completed processing.

**Remaining human or credentialed follow-up:** Open App Store Connect, select Pathway, then
TestFlight, version 1.0.13 build 14. Confirm processing finishes, resolve any Apple-reported
compliance requirement if present, and confirm the build belongs to the intended existing
tester group and is available to its testers. No tester/group assignment was changed by this
recovery. A machine with the existing App Store Connect query credentials can perform the
same checks using the build resource above. No additional upload authorization is needed,
and this task did not request it.

The signing problem is resolved and the requested upload is complete. Tester installation
and real-device behavior remain unverified. Do not describe the build as available to testers
until those checks pass. No public App Store release was submitted.

The release checkout remains at the exact source commit with no tracked modifications.
Only this report was committed and pushed on `status/testflight-14-recovery-20260912`.
No PR was opened and nothing was merged to main.

Apple documents the saved-account cloud-signing route in
[Cloud-managed certificates](https://developer.apple.com/help/account/certificates/cloud-managed-certificates).
The [certificate creation API](https://developer.apple.com/documentation/appstoreconnectapi/post-v1-certificates)
fallback was unnecessary because the existing Xcode signing setup succeeded.
