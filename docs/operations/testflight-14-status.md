# TestFlight 1.0.13 (14) status

Inspected on 2026-09-12 at 06:12 UTC. Build 14 is archived locally, but distribution export failed before upload. It is not available to TestFlight testers.

Source: `e030add279629cc6eb049ee6d5753a886eb97aa3` on `release/ios-testflight-connection-fixes-20260912`. This report branch, `status/testflight-14-20260912`, starts at that source and changes only this report. The release checkout is preserved.

## Original thread and outstanding question

Read both messages and activity through the end of local Pathway thread `thread:project:9fe2bf54-18bc-4d4c-afd1-8f2ebafc399f:32f82c0a-58c4-41a7-af8c-e986683edaac`, titled “Publish TestFlight Build with iOS Fixes.” Its final response at 2026-09-12 05:31:53.958 UTC explicitly reports no upload and no processing. The thread is completed with no active run and two runtime questions still marked waiting.

The actual outstanding question, posted at 2026-09-12 05:30:19.722 UTC, is:

> Where is the existing iOS distribution certificate/private key (.p12), or an App Store Connect API key with cloud-signing access, that was used for build 13? Apple denied cloud signing for this Mac’s current key. Please provide only the private file location, not credential contents.

The question contains no secret or account identifier requiring redaction. An earlier waiting question at 05:19:00.572 UTC asked where the App Store Connect credentials were stored; the thread subsequently reported finding and successfully authenticating with the existing API key at 05:23:42.893 UTC. That earlier question is stale; distribution signing access is the remaining blocker.

## Verified state and blocker

- The existing archive is present. Its metadata identifies version 1.0.13, build 14, created at 2026-09-12 05:28:46 UTC. The original thread verified matching versions and App Groups for the app and both extensions, plus production service configuration.
- The archive uses development signing. A distribution-signed IPA was not produced. The local export log confirms `Cloud signing permission error` and `EXPORT FAILED`, with its last modification at 2026-09-12 05:29:57.728 UTC. App Store provisioning profiles for the app and extensions could not be obtained during that export.
- According to the original release investigation, the existing API key can authenticate to App Store Connect but lacks access to cloud-managed distribution certificates. The Mac has no local iOS distribution signing identity and no active Xcode Apple account for an alternative cloud-signing route.
- Apple upload did not succeed because no upload occurred. The saved App Store Connect query at 2026-09-12 05:31:10.828 UTC contains zero build-14 records. Processing had not started, and build 14 was unavailable to testers at that check. This follow-up inspected that saved response; it did not perform a new Apple query or claim a newer processing state.
- The original thread reports 12 native tests and 32 server/backend tests passing, focused lint passing, and successful Release compilation. This status-only follow-up did not repeat builds or tests.

## Required next action

Provide the original release thread with the private local file location of the existing distribution certificate/private key (.p12), or the existing API credentials with cloud-signing access used for build 13. Do not put credential contents in GitHub or chat. If access must be granted instead, the Apple team's Account Holder or Admin must enable cloud-managed distribution certificate access for the intended signing identity; any required Apple sign-in must be completed by the account owner.

Once signing access is available, continue in the original release thread: reuse the existing archive and export options, recheck App Store Connect for build 14 to avoid duplicate delivery, complete distribution export, verify signatures and the production APNs entitlement, then upload and verify processing and tester availability. Existing authorization already covers TestFlight upload; public App Store release is outside scope.

The latest “Yes do please” authorized inspecting this blocker and does not supply a credential location or choose an Apple account/team. No restart message was sent because the blocker requires human information or Apple access, not renewed upload permission. No duplicate build, export, or upload was started.

## Local evidence paths

Paths use `~` to avoid publishing the local account name. Evidence contents, signing credentials, and account identifiers are not attached.

| Evidence                      | Local path                                                                                            | Timestamp (UTC, 2026-09-12)                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Archive                       | `~/GitHub/pathway-testflight-20260912/.pathway/build/release/Pathway-1.0.13-14.xcarchive`             | Created 05:28:46                                   |
| Successful archive log        | `~/GitHub/pathway-testflight-20260912/.pathway/build/release/archive-api.log`                         | Archive success reported by thread at 05:29:51.637 |
| Distribution export failure   | `~/GitHub/pathway-testflight-20260912/.pathway/build/release/export.log`                              | Modified 05:29:57.728                              |
| Distribution diagnostics      | `/var/folders/7v/4ygtxscs0p1g1ctrm7xkn5yr0000gn/T/Pathway_2026-09-12_15-29-43.786.xcdistributionlogs` | Created 05:29:43.786, as recorded in thread        |
| Export options for resumption | `~/GitHub/pathway-testflight-20260912/.pathway/build/release/ExportOptions.plist`                     | Modified 05:29:42.847                              |
| Saved Apple build-14 query    | `~/GitHub/pathway-testflight-20260912/.pathway/build/release/asc-build-14-status.json`                | Modified 05:31:10.828                              |
| Release record                | `~/GitHub/pathway-testflight-20260912/.pathway/build/release/RELEASE.md`                              | Modified 05:31:09.891                              |
| Structured release record     | `~/GitHub/pathway-testflight-20260912/.pathway/build/release/release-record.json`                     | Modified 05:31:09.891                              |

There is no successful upload receipt. The evidence records failure before upload.
